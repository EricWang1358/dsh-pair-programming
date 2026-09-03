/**
 * dsh-pair-programming: Agile pair programming for DeepSeek Harness.
 *
 * A self-contained host-plane plugin: it builds its own pair-programming
 * runtime (team state, task dependency graph, JSONL mailboxes, event-driven
 * scheduler) directly on the DSH host primitives (ctx.subagents / ctx.tools /
 * ctx.systemPrompt / ctx.agents / ctx.llm), with NO third-party plugin
 * dependency. It registers the `pair_*` tools into the shared tools registry,
 * one usage section into the global system prompt, and the `/pair` slash
 * command + gesture boundary, so any session can start an Agile
 * pair-programming team (Driver / Navigator / Challenger) with a hard quality
 * gate on task completion.
 *
 * Installation (bundle): `dsh plugin --profile <name> add <this package>`
 * (or a local path). The bundle patch mounts this plugin row into the host
 * composition; the plugin needs no realm.
 *
 * Mature concurrency/persistence patterns (serial locks, Windows-tolerant
 * atomic writes, JSONL mailboxes, attempt capability tokens, event-driven
 * scheduling, dual-channel activation) are adapted from the MIT-licensed
 * @nanmicoder/dsh-agent-teams — see lib/ module headers for per-file credit.
 *
 * @module dsh-pair-programming
 */
import { Config } from './config.js';
import { resolveConfig } from './defaults.js';
import { usageSectionText } from './prompt.js';
import { registerPairCommand, installPairGestureBoundary } from './command.js';
import { installPairSettings, parseDod } from './settings.js';
import { installMemberSelectionRuntime } from './runtime/members.js';
import { installPairScheduler } from './runtime/scheduler.js';
import { registerLifecycleTools } from './tools/lifecycle.js';
import { registerFlowTools } from './tools/flow.js';
import { registerTaskTools } from './tools/task.js';
import { registerRiskTools } from './tools/risk.js';
import { registerOracleTools } from './tools/oracle.js';
import { registerArbitrateTools } from './tools/arbitrate.js';

export const name = 'pair-programming';
export const inject = ['tools', 'llm', 'subagents', 'systemPrompt', 'agents'];
export { Config };

export function apply(ctx, config) {
  const resolved = { ...resolveConfig(config), dod: parseDod(config.dod) };


  // 1. Member selections travel in startContinuable.agentOptions, which
  //    alpha.5 persists and reapplies during cold resume.
  const selections = installMemberSelectionRuntime();

  // 2. Event-driven scheduler (agent/status idle edges + task-graph kicks).
  const scheduler = installPairScheduler(ctx, resolved, { selections });

  const runtime = { selections, scheduler };

  // 3. The pair_* tool surface.
  registerLifecycleTools(ctx, resolved, runtime);
  registerFlowTools(ctx, resolved, runtime);
  registerTaskTools(ctx, resolved, runtime);
  registerRiskTools(ctx, resolved, runtime);
  registerOracleTools(ctx, resolved);
  registerArbitrateTools(ctx, resolved, runtime);

  // 4. The captain's usage policy in the global system prompt.
  ctx.systemPrompt.section({
    name: 'pair-programming:usage',
    order: resolved.promptSectionOrder,
    text: usageSectionText({ tddMode: resolved.tddMode, pairStyle: resolved.pairStyle }),
  });

  // 5. Deterministic activation: the closed-namespace `/pair` host command
  //    (lazy — `commands` ships in every standard profile's base bundle but a
  //    minimal composition may omit it) plus the plain-text gesture boundary.
  if (resolved.slashCommand) {
    ctx.inject(['commands'], (commandCtx) => {
      registerPairCommand(commandCtx);
    });
    installPairGestureBoundary(ctx);
  }

  // 6. Runtime configuration surface (optional service): user overrides from
  //    the host settings service (Settings UI / ~/.dsh/settings.yaml) layered
  //    over this composition's YAML values. Every exposed field is read at
  //    call time by its consumers, so a committed change takes effect on the
  //    next tool call; the static system-prompt text keeps the composed values.
  //    Without a settings provider the plugin keeps working exactly as
  //    composed — no degradation, no extra moving parts.
  ctx.inject(['settings'], ({ settings }) => {
    installPairSettings(settings, ctx, resolved, config.dod);
  });
}
