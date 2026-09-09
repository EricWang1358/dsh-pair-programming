import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Beta admission gate: resolve the real DSH SDK, import the plugin entry, and
 * run apply() against a mock cordis context — asserting the tool/command/
 * listener wiring installs AND every SDK symbol the plugin imports at runtime
 * still exists. Any ERR_MODULE_NOT_FOUND or missing SDK export fails the gate,
 * which is exactly what must block a plugin from being enabled in a daily
 * profile after an SDK bump.
 *
 * Peers are host-provided singletons; when a plugin is loaded from a link, Node
 * resolves its imports from the plugin's REAL path upward, so we provision a
 * `node_modules/@deepseek-ai` junction pointing at the installed SDK the same
 * way a composed profile workspace would.
 */

function findSdkNodeModules() {
  // Candidate @deepseek-ai trees, most-specific-first.
  const here = fileURLToPath(new URL('../', import.meta.url));
  const candidates = [
    join(here, 'node_modules', '@deepseek-ai'),
    'D:\\Program Files\\nodejs\\node_global\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai',
    'C:\\Users\\Eric1\\.dsh\\profiles\\web\\node_modules\\@deepseek-ai',
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'dsh-tools', 'package.json')) && existsSync(join(c, 'dsh-agent', 'package.json'))) {
      return c;
    }
  }
  return undefined;
}

const sdk = findSdkNodeModules();
if (!sdk) {
  console.error('verify:startup FAILED: no installed @deepseek-ai SDK found to resolve peers against.');
  process.exit(1);
}

const pluginNM = join(fileURLToPath(new URL('../', import.meta.url)), 'node_modules');
const junction = join(pluginNM, '@deepseek-ai');
let createdJunction = false;
const alreadyOk = existsSync(join(junction, 'dsh-tools', 'package.json'));
if (!alreadyOk) {
  try {
    mkdirSync(pluginNM, { recursive: true });
    // A stale junction from an earlier run (or the removed dev link) must be
    // cleared before re-pointing, or symlinkSync rejects on an existing path.
    if (existsSync(junction)) rmSync(junction, { force: true, recursive: true });
    symlinkSync(sdk, junction, 'junction');
    createdJunction = true;
  } catch (error) {
    console.error(`verify:startup FAILED: cannot provision peer resolution junction -> ${sdk}\n${error.message}`);
    process.exit(1);
  }
}

const cleanup = () => { if (createdJunction) { try { rmSync(junction, { force: true, recursive: true }); } catch { /* ignore */ } } };

try {
  // 1. Entry importable (catches ERR_MODULE_NOT_FOUND across the internal graph).
  const mod = await import('../lib/index.js');
  const { name, inject, apply, Config } = mod;
  if (name !== 'pair-programming') { console.error(`verify:startup FAILED: unexpected plugin name "${name}"`); process.exit(1); }

  // 2. SDK symbols the plugin imports at runtime must exist (missing-export gate).
  const dshLlm = await import('@deepseek-ai/dsh-llm');
  const dshTools = await import('@deepseek-ai/dsh-tools');
  const dshSession = await import('@deepseek-ai/dsh-session');
  const needed = [
    ['@deepseek-ai/dsh-llm', 'ReasoningEffortId', dshLlm],
    ['@deepseek-ai/dsh-llm', 'createUserMessage', dshLlm],
    ['@deepseek-ai/dsh-tools', 'defineTool', dshTools],
    ['@deepseek-ai/dsh-session', 'KNOWN_SESSION_EVENT_TYPES', dshSession],
  ];
  const missingExports = needed.filter(([pkg, sym, ns]) => ns[sym] === undefined)
    .map(([pkg, sym]) => `${pkg}#${sym}`);
  if (missingExports.length) {
    console.error(`verify:startup FAILED: SDK is missing imported exports: ${missingExports.join(', ')}`);
    process.exit(1);
  }

  // 3. apply() wiring on a mock context.
  const reg = { tools: [], sections: [], commands: [], listeners: [], setup: 0 };
  const ctx = {
    logger: { warn() {}, debug() {}, info() {} },
    tools: { register: (t) => { reg.tools.push(t?.name); return () => {}; } },
    llm: { async resolveCallConfig(c) { return c; } },
    subagents: {
      getProvider: () => ({ prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } }),
      list: () => ['spawn'],
    },
    systemPrompt: { section: (s) => reg.sections.push(s.name) },
    agents: { get: () => undefined },
    commands: { register: (c) => { reg.commands.push(c.name); return () => {}; } },
    on: (e) => reg.listeners.push(e),
    inject: (deps, fn) => { if (deps.includes('commands')) fn(ctx); },
    effect: (fn) => { if (typeof fn === 'function') { try { fn(); } catch { /* effect needs live ctx */ } } },
  };
  apply(ctx, {});

  const expectTools = ['pair_start', 'pair_oracle_write', 'pair_oracle', 'pair_propose', 'pair_review', 'pair_red', 'pair_green', 'pair_refactor', 'pair_report', 'pair_verify', 'pair_risk', 'pair_arbitrate', 'pair_gate_check', 'pair_integrate', 'pair_backlog', 'pair_repair_verify_plan', 'pair_task_create', 'pair_task_amend', 'pair_task_claim', 'pair_task_update', 'pair_rotate', 'pair_status', 'pair_retro', 'pair_stop', 'pair_interrupt', 'pair_mailbox_read'];
  const missingTools = expectTools.filter(t => !reg.tools.includes(t));
  const unexpectedTools = reg.tools.filter(t => !expectTools.includes(t));
  const needCommands = reg.commands.includes('pair');
  const needListeners = reg.listeners.includes('agent/status') && reg.listeners.includes('agent/pre-step');

  console.log(`apply() wired: ${reg.tools.length} tools, sections=[${reg.sections}], commands=[${reg.commands}], listeners=[${reg.listeners}]`);
  if (missingTools.length || unexpectedTools.length || !needCommands || !needListeners || !reg.sections.includes('pair-programming:usage')) {
    const why = [];
    if (missingTools.length) why.push(`missing tools: ${missingTools.join(', ')}`);
    if (unexpectedTools.length) why.push(`unexpected tools not in expectTools: ${unexpectedTools.join(', ')} — update that list deliberately, or the release gate goes blind to a new tool`);
    if (!needCommands) why.push('/pair command not registered');
    if (!needListeners) why.push('gesture/status listeners not installed');
    console.error(`verify:startup FAILED: ${why.join('; ')}`);
    process.exit(1);
  }
  console.log(`verify:startup OK: entry imports against SDK ${sdk}, all runtime SDK exports present, ${reg.tools.length} tools + /pair + gesture boundary + scheduler observer install.`);
  process.exit(0);
} catch (error) {
  console.error('verify:startup FAILED:', error?.message ?? error);
  if (error?.code === 'ERR_MODULE_NOT_FOUND') console.error('  -> ERR_MODULE_NOT_FOUND: a required peer is not resolvable (model it as a required dependency/peer).');
  process.exit(1);
} finally {
  cleanup();
}
