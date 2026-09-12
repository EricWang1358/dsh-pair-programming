import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
if (!process.argv[1] || realpathSync(process.argv[1]) !== realpathSync(fileURLToPath(import.meta.url))) {
  throw new Error('PAIR_TEST_PROCESS_REQUIRED: run startup verification in a separate Node process');
}
/** Read-only native SDK startup verification. Dependency setup is a separate action. */
const sdk = 'existing module resolution (no filesystem provisioning)';

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

  const expectTools = ['pair_start', 'pair_oracle_write', 'pair_oracle', 'pair_propose', 'pair_review', 'pair_red', 'pair_green', 'pair_refactor', 'pair_report', 'pair_verify', 'pair_risk', 'pair_arbitrate', 'pair_gate_check', 'pair_integrate', 'pair_backlog', 'pair_repair_verify_plan', 'pair_task_create', 'pair_task_amend', 'pair_task_claim', 'pair_task_update', 'pair_rotate', 'pair_status', 'pair_retro', 'pair_stop', 'pair_interrupt', 'pair_mailbox_read', 'pair_yield', 'pair_cleanup', 'pair_correction'];
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
}
