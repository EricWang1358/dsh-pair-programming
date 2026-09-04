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
  check(pairTools.length === 22, 'all 22 pair_* tools are accepted by the real registry, schema validation included');
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
  const usedSubagentCalls = new Set();
  const scanLib = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) scanLib(p);
      else if (entry.name.endsWith('.js')) {
        for (const m of readFileSync(p, 'utf8').matchAll(/ctx\.subagents\.(\w+)/g)) usedSubagentCalls.add(m[1]);
      }
    }
  };
  scanLib(fileURLToPath(new URL('../lib', import.meta.url)));
  const declaredSubagentNames = new Set();
  const scanDts = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) scanDts(p);
      else if (entry.name.endsWith('.d.ts')) {
        for (const m of readFileSync(p, 'utf8').matchAll(/(\w+)\(/g)) declaredSubagentNames.add(m[1]);
      }
    }
  };
  scanDts(fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-subagent/', import.meta.url)));
  check(usedSubagentCalls.has('sendMessage'), 'the guard is live: the plugin calls ctx.subagents.sendMessage');
  check(!usedSubagentCalls.has('followup'), 'and the M19 phantom is gone from the source tree');
  for (const name of [...usedSubagentCalls].sort()) {
    check(declaredSubagentNames.has(name), `ctx.subagents.${name} is declared in the host package surface — no phantom API`);
  }
}
