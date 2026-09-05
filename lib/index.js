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
import { installCeStatus } from './integrations/ce-install.js';
import { installNavModelStatus } from './integrations/nav-model.js';
import { installCeProvider, makeCeProvider, makeLaneResolver } from './integrations/ce-provider.js';
import { hasActiveTeam } from './state/store.js';
import { appendCeLoad } from './integrations/ce-ledger.js';
import { installCeLoadWatch } from './integrations/ce-watch.js';
import { stateRootOf } from './state/layout.js';
import { probeCe } from './integrations/ce-probe.js';
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


  // 0. Compound Engineering state. Declared first because the scheduler (2)
  //    hands it to a recycled seat and the settings surface (6) drives it; the
  //    provider that fills `load` is installed further down, once ctx.skills is
  //    known to exist. Every field is read through a function so nothing here
  //    captures a stale value.
  const ceState = { probe: undefined };
  const ceProvider = { refresh: () => {} };
  const ce = {
    lane: () => resolved.ceLanes,
    probe: () => ceState.probe,
    cache: new Map(),
    load: undefined,
  };

  // 1. Member selections travel in startContinuable.agentOptions, which
  //    alpha.5 persists and reapplies during cold resume.
  const selections = installMemberSelectionRuntime();

  // 2. Event-driven scheduler (agent/status idle edges + task-graph kicks).
  const scheduler = installPairScheduler(ctx, resolved, { selections, ce });

  const runtime = { selections, scheduler, ce };

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
    text: usageSectionText({ tddMode: resolved.tddMode, pairStyle: resolved.pairStyle, defaultMode: resolved.defaultMode, ceLanes: resolved.ceLanes, ceSoloLane: resolved.ceSoloLane }),
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
  //    (The registration itself sits below, after the CE state it feeds.)

  // 7. Compound Engineering (optional, `ceLanes: off` by default).
  //    The detected checkout and the current lane are read on every catalog
  //    fetch, so a lane switch takes effect on the next fetch rather than at
  //    registration time. With the lane off — or with no checkout detected —
  //    the provider contributes no candidates, and `dsh-tool-skill` sends no
  //    catalog tokens for an empty list, so an unused integration is free.
  const runCeProbe = async () => {
    ceState.probe = await probeCe({ cePath: resolved.cePath });
    // Also on `resolved` so pair_status can name the detection without a
    // second source of truth for it.
    resolved.ceProbe = ceState.probe;
    ceProvider.refresh();
    return ceState.probe;
  };
  // Every skill load goes through the host `skill` tool, whatever provider
  // served the body. This is the only observation point that sees a CE skill
  // loaded from someone else's skill root — which is exactly the case the
  // gate's write-lane refusal exists for, and the case our own ledger could
  // never see. Installed unconditionally: it costs one string compare per tool
  // call and it must keep watching even with `ceLanes: off`, because a user
  // can wire CE into a skill root without telling this plugin anything.
  installCeLoadWatch(ctx, resolved);

  ctx.inject(['skills'], (skillCtx) => {
    const provider = makeCeProvider({
      state: () => ({ lane: resolved.ceLanes, soloLane: resolved.ceSoloLane, probe: ceState.probe }),
      // Which lane a workspace is in is decided by the board, not by a knob:
      // while a pair team is live there, the narrow set; otherwise the solo set.
      laneOf: makeLaneResolver({ teamLive: (cwd) => hasActiveTeam(stateRootOf(cwd, resolved)) }),
      // Every served body is recorded. The provider knows a cwd, not a seat,
      // so the gate attributes a load by workspace and time window and says so.
      onLoad: (row) => {
        const workspace = typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : undefined;
        if (workspace === undefined) return;
        void appendCeLoad(stateRootOf(workspace, resolved), row);
      },
    });
    const installed = installCeProvider(skillCtx, { provider });
    ceProvider.refresh = installed.refresh;
    // The push path loads through the same provider, so a pushed body carries
    // the same boundary preamble and lands in the same ledger as a pulled one.
    // `teamLive: true` is stated rather than resolved: a push happens only at a
    // seat respawn, which by construction is inside a live team, and this call
    // has no session cwd for the resolver to work from.
    ce.load = async (name, opts = {}) => {
      const options = { cwd: opts.cwd, teamLive: true };
      const catalog = await provider.list(options);
      const candidate = catalog.find(entry => entry.name === name);
      return candidate === undefined ? undefined : provider.get(candidate, options);
    };
  });
  if (resolved.ceLanes !== 'off' || resolved.ceSoloLane !== 'off') {
    void runCeProbe().catch((error) => ctx.logger?.warn?.(`pair-programming: CE probe failed: ${String(error)}`));
  }

  // The settings registration (6) closes over the CE state above: the card's
  // Detect button can only write a value, so the host observes that committed
  // write, probes read-only, and publishes into its own derived namespace.
  // Without a settings provider there is no card and no button, and detection
  // falls back to the one probe at apply time — CE is a convenience, never
  // something the protocol depends on.
  ctx.inject(['settings'], ({ settings }) => {
    const ce = installCeStatus(settings, resolved, { logger: ctx.logger, probe: runCeProbe });
    const nav = installNavModelStatus(settings, resolved, { logger: ctx.logger, llm: ctx.llm });
    installPairSettings(settings, ctx, resolved, config.dod, (next) => {
      ce.onSettingsCommitted(next);
      nav.onSettingsCommitted(next);
      // A lane switched on from the card needs a checkout before it can serve
      // anything, and the user did not necessarily press Detect first.
      if (resolved.ceLanes !== 'off' && ceState.probe === undefined) {
        void ce.probeNow().catch(() => {});
      }
      ceProvider.refresh();
    });
    void ce.probeNow().catch(() => {});
  });
}
