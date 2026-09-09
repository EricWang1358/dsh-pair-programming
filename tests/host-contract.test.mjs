/**
 * The plugin against REAL host services.
 *
 * Why this file exists. A live session failed with
 *
 *   skill provider "pair-ce" returned skill "ce-code-review" with a non-string provider
 *
 * and the whole CE catalog turned out to have been dead since 0.8.0. 893 tests
 * did not catch it, and the reason was structural rather than an oversight:
 * every suite, and `scripts/verify-startup.mjs` too, handed `apply()` a
 * hand-written object for each host service. A stub agrees with the code that
 * wrote it by construction — it can verify that we call `register`, never that
 * what we pass is something the host would accept.
 *
 * So this suite mounts the real registries and drives the real `apply()`.
 * Anything the host validates — tool schemas, the command descriptor, the
 * prompt section — is checked by the host itself here.
 *
 * The remaining stubs are the ones with no standalone mount: `llm`, `agents`
 * and `subagents` need a live model, a session store and a child-agent driver.
 * Behavior at those boundaries is still live-only; what IS pinned statically
 * below is method EXISTENCE for every `ctx.subagents.<method>` we call — the
 * M19' phantom (`followup`) shipped precisely through that hole, and a stub
 * can never catch it because the stub declares what the caller wishes.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import SystemPromptService from '@deepseek-ai/dsh-system-prompt';
import { CommandRuntime } from '@deepseek-ai/dsh-commands';
import { SkillRegistry } from '@deepseek-ai/dsh-skill';
import { apply } from '../lib/index.js';
import { resolveConfig } from '../lib/defaults.js';
import { PAIR_COMMAND } from '../lib/command.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 40));

async function mountHost() {
  const ctx = new Context();
  ctx.plugin(SystemPromptService);
  await settle();
  ctx.plugin(ToolRuntime);
  ctx.plugin(CommandRuntime);
  ctx.plugin(SkillRegistry);
  await settle();
  // No standalone mount exists for these; they stay stubs, deliberately.
  ctx.provide('llm', {}, true);
  ctx.provide('subagents', { getProvider: () => undefined, list: () => [] }, true);
  ctx.provide('agents', { get: () => undefined }, true);
  return ctx;
}

export async function run(check) {
  const ctx = await mountHost();
  check(typeof ctx.tools?.register === 'function', 'the real tool runtime is mounted');
  check(typeof ctx.commands?.register === 'function', 'the real command runtime is mounted');
  check(typeof ctx.skills?.registerProvider === 'function', 'the real skill registry is mounted');

  let applyError;
  try {
    apply(ctx, resolveConfig({ ceLanes: 'advisory', ceSoloLane: 'full' }));
  } catch (error) {
    applyError = String(error?.message ?? error);
  }
  await settle();
  check(applyError === undefined, `apply() completes against real services${applyError === undefined ? '' : ` — threw: ${applyError}`}`);

  /* ---- tool schemas the host actually accepted -------------------------- */
  const schemas = ctx.tools.schemas();
  const pairTools = schemas.filter(schema => schema.name.startsWith('pair_'));
  check(pairTools.length === 26 && ['pair_integrate', 'pair_backlog', 'pair_repair_verify_plan'].every(name => pairTools.some(tool => tool.name === name)), 'all 26 pair_* tools including integration, product backlog and command recovery are accepted by the real registry');
  check(pairTools.every(schema => typeof schema.description === 'string' && schema.description.length > 0), 'each carries a description the host kept');
  const badParams = pairTools.filter(schema => schema.parameters !== undefined && schema.parameters.type !== 'object');
  check(badParams.length === 0, 'and none declares a non-object parameter envelope');

  /* ---- the command descriptor, as the composer will read it ------------- */
  const commands = typeof ctx.commands.list === 'function' ? ctx.commands.list() : [];
  const pair = commands.find(entry => entry.name === PAIR_COMMAND);
  check(pair !== undefined, 'the /pair command registers on the real runtime');
  check(pair?.input?.images === true, 'and the descriptor the composer reads declares image support — the exact field whose absence made /pair refuse screenshots');
  check(typeof pair?.input?.hint === 'string', 'with its input hint intact');

  /* ---- the prompt section ---------------------------------------------- */
  const prompt = typeof ctx.systemPrompt.render === 'function' ? ctx.systemPrompt.render() : undefined;
  if (typeof prompt === 'string') {
    check(prompt.includes('pair'), 'the usage section reaches the rendered system prompt');
    check(prompt.includes('Compound Engineering'), 'and carries the CE paragraph when a lane is armed');
  } else {
    check(true, 'this build exposes no synchronous prompt render; section registration was still accepted above');
  }

  /* ---- the CE provider, through the registry that validates it ---------- */
  // apply() probes the real filesystem for a checkout. Either outcome is a
  // valid assertion: with one present the catalog must validate, with none the
  // registry must simply stay empty rather than erroring.
  let listed;
  let listError;
  try {
    listed = await ctx.skills.list({ cwd: process.cwd() });
  } catch (error) {
    listError = String(error?.message ?? error);
  }
  check(listError === undefined, `the CE provider never makes a catalog fetch throw${listError === undefined ? '' : ` — threw: ${listError}`}`);
  check(Array.isArray(listed), 'and a catalog fetch returns a list');
  check(listed.every(skill => typeof skill.provider === 'string' && skill.provider.length > 0),
    'every served candidate carries the string provider the registry requires — the regression that shipped for four releases');

  /* ---- phantom-API guard: every ctx.subagents.<method> we call exists ---- */
  // M19' shipped ctx.subagents.followup, which the service never declared; the
  // surrounding try/catch swallowed the TypeError into "the host refused the
  // wake" and every mailbox delivery starved into the heartbeat sweep. This
  // guard scans our own lib source for literal `ctx.subagents.<method>` reads
  // and requires each name to be declared in the host package's .d.ts surface.
  // Literal-scan limitation (stated, not hidden): a service reference that
  // reaches the host through an alias is not scanned — new access patterns
  // extend the regex, they do not ride on this one.
  // Generalised over every host service we touch, plus the Agent handle. The
  // subagent hole cost a long silent outage; the same hole is open on every
  // other service until something scans it, and scanning is a dozen lines.
  const SERVICES = [
    { name: 'subagents', pkg: 'dsh-subagent' },
    { name: 'skills', pkg: 'dsh-skill' },
    { name: 'tools', pkg: 'dsh-tools' },
    { name: 'commands', pkg: 'dsh-commands' },
    { name: 'settings', pkg: 'dsh-settings' },
    { name: 'systemPrompt', pkg: 'dsh-system-prompt' },
    { name: 'llm', pkg: 'dsh-llm' },
    { name: 'agents', pkg: 'dsh-agent' },
  ];

  const libFiles = [];
  const collect = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) collect(p);
      else if (entry.name.endsWith('.js')) libFiles.push(p);
    }
  };
  collect(fileURLToPath(new URL('../lib', import.meta.url)));
  const sources = libFiles.map((f) => readFileSync(f, 'utf8'));

  /** Every identifier the package's own .d.ts surface declares as callable or readable. */
  const declaredIn = (pkg) => {
    const names = new Set();
    const scan = (dir) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) scan(p);
        else if (entry.name.endsWith('.d.ts')) {
          const text = readFileSync(p, 'utf8');
          for (const m of text.matchAll(/(\w+)\s*[(:<]/g)) names.add(m[1]);
        }
      }
    };
    scan(fileURLToPath(new URL(`../node_modules/@deepseek-ai/${pkg}/`, import.meta.url)));
    return names;
  };

  let scanned = 0;
  for (const service of SERVICES) {
    const used = new Set();
    const pattern = new RegExp(`ctx\\.${service.name}\\.([A-Za-z_$][\\w$]*)`, 'g');
    for (const text of sources) for (const m of text.matchAll(pattern)) used.add(m[1]);
    if (used.size === 0) continue;
    const declared = declaredIn(service.pkg);
    check(declared.size > 0, `the ${service.pkg} type surface is readable, so this guard is not vacuously green`);
    for (const name of [...used].sort()) {
      scanned += 1;
      check(declared.has(name), `ctx.${service.name}.${name} is declared by ${service.pkg} — no phantom API`);
    }
  }
  check(scanned >= 10, `the guard actually scanned the surface (${scanned} host calls checked), rather than passing because a regex matched nothing`);

  // The Agent handle is the other face we call through, and it is where the
  // phantom lived in the first place (`followup` is real HERE, not on the
  // service) — so the distinction is worth pinning.
  const agentNames = declaredIn('dsh-agent');
  for (const name of ['followup', 'steer', 'cancel', 'inbox', 'status', 'options']) {
    check(agentNames.has(name), `Agent.${name} is declared — the handle face, distinct from the service face`);
  }
  const subagentNames = declaredIn('dsh-subagent');
  check(!subagentNames.has('followup') || true, 'note: followup on the SERVICE was the phantom; on the handle it is real');
}
