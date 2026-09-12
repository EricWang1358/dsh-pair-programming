/**
 * Lifecycle tools: pair_start / pair_status / pair_rotate / pair_stop.
 *
 * @module dsh-pair-programming/tools/lifecycle
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { oracleDirectory, scratchDirectory } from '../state/artifacts.js';
import { resumeTeam, listRuns, requireWorkspaceAvailable } from './resume.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withLock, sanitizeKey } from '../state/lock.js';
import { stateRootFor, workspaceOf, requireAgent, requireParticipantTeam, isCaptain, identityOf, deliverProtocolMessage } from './shared.js';
import { teamLockKey, teamDirOf, lessonsFileOf } from '../state/layout.js';
import {
  createTeamDir, findTeamByCaptain, readTeam, writeTeam, removeTeamDir,
  latestGatePass,
} from '../state/store.js';
import { readUnreadMailbox, discardUnreadMailbox } from '../state/mailbox.js';
import { atomicWriteText, stripLeadingBom } from '../state/atomic.js';
import { currentCycleOf, initialProtocolState } from '../protocol/machine.js';
import { personaFor, memberWelcome } from '../protocol/personas.js';
import { resolveMemberLlmSelection, seatModelRequest, isQuotaError, setNavRouteFallback, spawnMember, interruptMember, navRouteFallbackFor } from '../runtime/members.js';
import { retireSpawnedMembers } from '../runtime/retire.js';
export { retireSpawnedMembers } from '../runtime/retire.js';
import { appendPairEvent, captainSessionOf } from '../events.js';
import { encodeMessage } from '../protocol/messages.js';
import { EvidenceCache } from '../state/evidence-cache.js';
import { captureBaseline, runDodCommand } from './gate-exec.js';
import { TDD_MODES, PAIR_STYLES, TEAM_MODES } from '../defaults.js';
import { oracleSummary } from '../protocol/oracle.js';
import { nextObligation, obligationLine, unverifiedCycles, yieldedObligations, blockingCause } from '../protocol/obligation.js';
import { attentionSet, attentionLines } from '../protocol/attention.js';
import { stallDiagnosis, goalLoopAdvice } from '../protocol/stall.js';
import { taskDesignContext } from '../protocol/design.js';
import { normalizeUseCases, goalCoverage } from '../protocol/coverage.js';
import { completionReadiness, makeCompletionReceipt } from '../protocol/completion.js';
import { declares, openDisclosures, disclosureSummary, residualLedger, residualSummary } from '../protocol/disclosure.js';
import { gateStateFingerprint } from '../protocol/gate.js';
import { ceStatusLine } from '../integrations/ce-status-line.js';
import { ceMomentLine } from '../integrations/ce-moments.js';
import { readCeLoads, writeLaneViolation } from '../integrations/ce-ledger.js';
import { admitLessons, overflowRefusal, DEFAULT_MAX_CARRIED, lessonLine } from '../protocol/lessons.js';
import { commandShapeError, exitSemantics } from '../protocol/command-shape.js';
import { allowedWriteSet } from '../protocol/scope.js';
import { seesCandidate, cycleExposure, taskExposure, summaryFor } from '../protocol/exposure.js';
import { workspaceFingerprint } from './oracle-exec.js';
import { createDriverWorktrees, removeDriverWorktrees, requireDriverCheckpoint, runtimePathsOf } from '../runtime/worktrees.js';
import { productSummary } from '../protocol/product.js';



/** Read the previous session's retro keep/try lessons, if any. */
async function loadProcessLessons(stateRoot) {
  try {
    const parsed = JSON.parse(stripLeadingBom(await readFile(lessonsFileOf(stateRoot), 'utf8')));
    return parsed && Array.isArray(parsed.keep) && Array.isArray(parsed.try) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the team shape before touching the filesystem or a subagent provider.
 * Keeping it pure makes the settings card's activation semantics testable
 * without spending a DSH turn or depending on the host's process sandbox.
 */
export function resolveStartComposition(args, config) {
  const configuredMode = TEAM_MODES.includes(config.defaultMode) ? config.defaultMode : 'light';
  if (args.mode !== undefined && !TEAM_MODES.includes(args.mode)) {
    throw new Error(`unknown team mode "${args.mode}" (${TEAM_MODES.join(' | ')})`);
  }
  // Settings writes are field-by-field. The experiment stays inert while its
  // command is absent, so a briefly half-configured toggle cannot make an
  // ordinary start fail a dual-worktree preflight.
  const configuredIntegrationCommand = String(config.dualDriverIntegrationCommand ?? '').trim();
  const automaticDualDrivers = config.experimentalDualDrivers === true && configuredIntegrationCommand !== '';
  const drivers = args.drivers ?? (automaticDualDrivers ? 2 : 1);
  if (drivers !== 1 && drivers !== 2) throw new Error('drivers must be 1 or 2');
  const mode = args.mode === undefined ? (drivers === 2 ? 'light' : configuredMode) : args.mode;
  if (drivers === 2 && mode === 'solo') throw new Error('two Drivers require light or full mode');
  const integrationCommand = String(args.integration_command ?? (configuredIntegrationCommand || config.dodCommand) ?? '').trim();
  if (drivers === 2) {
    if (!integrationCommand) throw new Error('two Drivers require integration_command for whole-suite merge verification');
    const problem = commandShapeError(integrationCommand, { field: 'integration_command' });
    if (problem) throw new Error(problem);
  }
  // Declared runtime inputs for the disposable integration checkout. Only the
  // isolated path has one, so a declaration without drivers=2 is refused here
  // rather than dropped: a captain who asked for a seeded checkout must not be
  // told the team started and then watch the seed silently not happen.
  const runtimePaths = runtimePathsOf(args.integration_runtime_paths);
  if (drivers !== 2 && runtimePaths.length) throw new Error('integration_runtime_paths needs drivers=2: only an isolated Driver team has a disposable integration checkout to seed');
  return { drivers, mode, integrationCommand, runtimePaths };
}

export function registerLifecycleTools(ctx, config, runtime) {

  const { selections, scheduler } = runtime;

  /* -------------------------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_start',
    description: 'Start an Agile pair-programming team on a goal: you (the caller) become the captain, and this spawns the Driver (sole file writer), Navigator (reviewer + quality gate), and in full mode the Challenger (adversarial risk explorer) as durable continuable subagents with role personas. Options: tdd_mode enforce (Test-First cycles RED->GREEN->REFACTOR, default) | coach (recommended, not enforced) | off (legacy cycles); style traditional | strong | ping-pong (pairing-style semantics). Prior retro lessons are inherited only with inherit_lessons=true. resume_team adopts an existing board instead of resetting progress. One team per captain.',
    parameters: {
      goal: { type: 'string', description: 'Required for a new team: what the pair team should accomplish.' },
      mode: { type: 'string', description: '"solo" (Captain + isolated SPEC), "light" (Driver+Navigator), or "full" (adds Challenger); omitted uses configured defaultMode (solo by default).' },
      drivers: { type: 'number', description: '1 (default) or 2. Two Drivers require a clean Git repository with a committed checkpoint and use separate worktrees with serialized, tested integration. If unavailable, propose a local Git checkpoint to the user; initialization and the exact commit scope need their approval, then retry. Never discard work or initialize silently. Omitted uses the Experimental: Isolated dual Drivers setting when it has a dedicated integration command; mode then defaults to light.' },
      integration_command: { type: 'string', description: 'Required for drivers=2 unless the dedicated dual-Driver integration command or dodCommand is configured: whole-suite regression command run on every merged candidate.' },
      integration_runtime_paths: { type: 'array', items: { type: 'string' }, description: 'Optional, dual Driver only: the runtime inputs this run declares for the disposable integration checkout, as literal relative paths inside the workspace (for example data/jobs.json). That checkout is a Git worktree, so it materialises TRACKED files only: an app whose runtime data is gitignored has an incomplete environment there, its oracles report PREREQ and its whole-suite command exits on a missing instrument, and both read as a failed candidate. Only the paths named here are copied, after the merge and before verification. A path the merged tree already has wins, so a candidate that legitimately carries its own tracked data file is never overwritten; a link is never followed or copied; and a declared input missing from the canonical workspace is reported as an environment diagnostic on the integration receipt. Omit to copy nothing.' },
      use_cases: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Required for a new team. Every independently observable requirement, before implementation: [{actor,intent,outcome,acceptance_criteria[],design?,interactions?}]. Optional design: {responsibility,approach,invariants[],failure_behavior,tradeoffs,pattern?,pattern_reason?}; resolve open_questions before dispatch. Each interaction adds target (UC-N), requires (target AC ids), contract, acceptance_criteria[], and the same design fields. Interaction criteria receive additional AC ids and need one task owner plus provider dependencies. The plugin assigns UC-N / UC-N.AC-N ids and requires every criterion on a task, in an oracle, and completed.' },
      tdd_mode: { type: 'string', description: 'enforce (default) | coach | off — how strictly the RED->GREEN->REFACTOR order is tool-enforced.' },
      style: { type: 'string', description: 'traditional (default) | strong (idea holder dictates, Driver is the hands) | ping-pong (test author and implementer alternate).' },
      name: { type: 'string', description: 'Optional team name (defaults to a timestamped id).' },
      inherit_lessons: { type: 'boolean', description: 'Opt in to prior workspace retro lessons. Off by default so unrelated goals do not inherit old process decisions.' },
      resume_team: { type: 'string', description: 'Explicitly adopt an existing team in this workspace; preserve its board, evidence and worktrees, rebuilding only live seats. First inspect pair_status(list_runs=true). Do not pass new goal, mode, drivers or use_cases.' },
      resume_from_captain: { type: 'string', description: 'Required with resume_team: exact previous captain id returned by list_runs, guarding against a competing handoff.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: `Pair team "${value.team_id}" formed (${value.mode} mode), members: ${value.members.join(', ')}. Artifact root: ${value.artifact_root}; scratch root: ${value.scratch_root}. ${value.resumed ? value.next : ""} Phase: ${value.phase ?? "PLANNING"}.${value.use_cases?.some(c => c.design || c.interactions?.length) ? `\nFrozen use cases with assigned joint AC ids: ${JSON.stringify(value.use_cases)}` : ""}${value.parallel_policy ? `\n${value.parallel_policy}\nWorkspaces: ${JSON.stringify(value.workspaces)}` : ''}` + (config.experimentalLeanPrompt === true ? '\n\n' + fullUsageSectionText({ tddMode: config.tddMode, pairStyle: config.pairStyle, defaultMode: config.defaultMode, experimentalDualDrivers: config.experimentalDualDrivers, dualDriverIntegrationCommand: config.dualDriverIntegrationCommand, ceLanes: config.ceLanes, ceSoloLane: config.ceSoloLane }) : '') }],
    },
    async execute(args, exec) {
      const captain = requireAgent(exec);
      const stateRoot = stateRootFor(captain, config);
      if (args.resume_team !== undefined) return resumeTeam(ctx, config, captain, args, { selections, scheduler }, exec.signal);
      if (typeof args.goal !== 'string' || !args.goal.trim()) throw new Error('A goal is required for a new team');
      const { drivers, mode, integrationCommand, runtimePaths } = resolveStartComposition(args, config);
      if (args.use_cases === undefined) throw new Error('missing required property "use_cases" for a new team');
      const useCases = normalizeUseCases(args.use_cases);
      const tddMode = TDD_MODES.includes(args.tdd_mode) ? args.tdd_mode : config.tddMode;
      const pairStyle = PAIR_STYLES.includes(args.style) ? args.style : config.pairStyle;
      const teamName = (args.name?.trim()) || `pair-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const teamId = sanitizeKey(teamName);
      const lessons = args.inherit_lessons === true ? await loadProcessLessons(stateRoot) : undefined;
      return withLock('workspace-start:'+stateRoot, async () => {
        const current = await findTeamByCaptain(stateRoot, captain.id);
        if (current !== undefined) {
          throw new Error(`you already lead team "${current.name}" — preserve its checkpoint and finish its normal closure before starting another; do not abort or discard evidence merely to switch Driver count`);
        }
        await requireWorkspaceAvailable(ctx,stateRoot);
        return withLock(teamLockKey(stateRoot, teamId), async () => {
          const existing = await readTeam(stateRoot, teamId);
          if (existing !== undefined) {
            throw new Error(`team id "${teamId}" is taken — pick a different name`);
          }
          if (drivers === 2) await requireDriverCheckpoint(workspaceOf(captain));
          // The mark on the wall the scope check measures against.
          const baseline = await captureBaseline(workspaceOf(captain));
          const team = {
            id: teamId,
            artifactNamespace: randomUUID(),
            name: teamName,
            goal: args.goal,
            useCases,
            mode,
            tddMode,
            pairStyle,
            processLessons: lessons ? { keep: lessons.keep, try: lessons.try, fromTeam: lessons.teamId } : undefined,
            captainSessionId: captain.id,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            members: [],
            tasks: [],
            taskSeq: 0,
            protocol: initialProtocolState(),
            ...(baseline !== undefined ? { baseline } : {}),
            evidenceStats: { cacheHits: 0, cacheMiss: 0 },
          };
          await createTeamDir(stateRoot, team);
          // Spawn the roles. Order matters for clarity; light mode skips the challenger.
          // solo: one short-lived SPEC seat writes the acceptance oracle with
          // no repository tools, then retires. The caller implements against
          // the frozen standard itself — which is what happened in every
          // measured session anyway, only without paying for two idle seats.
          const roles = mode === 'solo' ? ['spec']
            : mode === 'light' ? ['driver', ...(drivers === 2 ? ['driver2'] : []), 'navigator']
              : ['driver', ...(drivers === 2 ? ['driver2'] : []), 'navigator', 'challenger'];
          try {
          if (roles.length > (config.maxMembers ?? 4)) throw new Error('requested team exceeds maxMembers');
          if (drivers === 2) {
            team.parallel = { ...await createDriverWorktrees(workspaceOf(captain), stateRoot, teamId),
              verificationCommand: integrationCommand, runtimePaths, integrations: {}, pending: {} };
            await writeTeam(stateRoot, team);
          }
          for (const name of roles) {
            const role = name === 'driver2' ? 'driver' : name;
            let selection = await resolveMemberLlmSelection(ctx, captain, seatModelRequest(config, role, team), exec.signal);
            const member = {
              id: '', name, role, provider: selection.provider, model: selection.model,
              reasoningEffort: selection.reasoningEffort, joinedAt: Date.now(), status: 'idle',
              welcome: memberWelcome(team, role),
            };
            const persona = personaFor(role)(team, member, config.stateDir);
            try {
              await spawnMember(ctx, config, selections, selection, captain, team, member, persona, exec.signal);
            } catch (error) {
              // Quota fallback (M20): the premium route died of exhaustion at
              // team formation — a bad or unpaid navigatorModel would otherwise
              // poison the whole pair_start. Retry once on the captain's route
              // and mark the card; anything else rolls the team back as before.
              const request = seatModelRequest(config, role, team);
              if (request.model !== undefined && isQuotaError(String(error))) {
                setNavRouteFallback('模型 ' + selection.provider + '/' + selection.model + ' 用量耗尽（'
                  + String(error?.message ?? error).slice(0, 160) + '）——' + role + ' 席位已回退为队长模型与配置', team);
                selection = await resolveMemberLlmSelection(ctx, captain, {}, exec.signal);
                member.provider = selection.provider;
                member.model = selection.model;
                member.reasoningEffort = selection.reasoningEffort;
                await spawnMember(ctx, config, selections, selection, captain, team, member, persona, exec.signal);
              } else {
                // team.members only gains an entry after its spawn resolved, so it
                // is exactly the live-orphan list: roll them back, then the dir.
                throw error;
              }
            }
            member.persona = undefined; // persona text is delivered at spawn; keep record lean
            delete member.welcome;
            team.members.push(member);
            appendPairEvent(ctx, captain.session, 'pair/member-added', {
              teamId, memberId: member.id, name: member.name, role,
            });
          }
          } catch (error) {
            await retireSpawnedMembers(ctx, captain, stateRoot, team.members);
            const preserved = team.parallel ? await removeDriverWorktrees(team.parallel) : [];
            if (preserved.length) {
              team.protocol.phase = 'ABORTED';
              team.parallel.cleanupWarnings = preserved;
              await writeTeam(stateRoot, team);
            } else await removeTeamDir(stateRoot, teamId);
            throw error;
          }
          team.protocol.phase = 'PLANNING';
          await writeTeam(stateRoot, team);
          // N5: put the fresh team on the heartbeat sweep list immediately, so a
          // protocol that stalls before its first kick is still recoverable.
          scheduler?.trackTeam?.(workspaceOf(captain), teamId);
          appendPairEvent(ctx, captain.session, 'pair/team-created', {
            teamId, captainSessionId: captain.id, name: teamName, goal: args.goal, mode,
          });
          return {
            team_id: teamId, team_name: teamName, mode, tdd_mode: tddMode, style: pairStyle,
            members: roles,
            artifact_root: oracleDirectory(team), scratch_root: scratchDirectory(team),
            ...(team.parallel ? { drivers: 2, workspaces: Object.fromEntries(Object.entries(team.parallel.slots).map(([name, slot]) => [name, slot.path])),
              integration_command: integrationCommand,
              ...(runtimePaths.length ? { runtime_paths: runtimePaths } : {}),
              parallel_policy: 'Declare write_paths, read_paths and resources on each task. Unknown or conflicting scopes queue. Each candidate needs final Navigator review, gate, captain pair_integrate, then owner completion. Never manually merge or switch Driver branches.' } : {}),
            use_cases: useCases,
            liveness: goalLoopAdvice(teamId),
            carried_lessons: lessons ? { keep: lessons.keep, try: lessons.try } : null,
          };
        });
      });
    },
  }));

  /* -------------------------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_status',
    description: 'Versioned protocol snapshot: phase, every cycle plus the current cycle, tasks with their current gate credential, stable coverage aliases, the full risk register plus open risks, open disclosures, recent decisions, protocol stats, and a cache hit summary. Event-driven monitoring — do not busy-poll. members[].mailbox.pending counts messages queued and not yet seen; a delivery claimed inside its 60s lease is excluded, so a 0 can mean "in flight", not "delivered".',
    parameters: {
      list_runs: { type: 'boolean', description: 'List workspace runs and previous Captain identities for an explicit handoff, without joining or waking any team.' },
      design_task_id: { type: 'string', description: 'Read the frozen design, collaborations and joint acceptance cases for one task. QA should read this before authoring its oracle.' },
      product_offset: { type: 'number', description: 'Product discovery page offset, default 0. Untriaged discoveries appear first, then recent history.' },
      product_limit: { type: 'number', description: 'Product discoveries per page, 1–100, default 20. Full ledger remains durable.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v.summary }] },
    async execute(_args, exec) {
      const offset = _args.product_offset ?? 0, limit = _args.product_limit ?? 20;
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('product_offset must be a nonnegative integer and product_limit must be 1–100');
      const caller = requireAgent(exec);
      const stateRoot = stateRootFor(caller, config);
      if (_args.list_runs === true) return listRuns(stateRoot);
      const team = await requireParticipantTeam(caller, config);
      // U2: the board is a surface, and one seat must not read the candidate through it.
      // A captain has no member record, so an unknown seat keeps the full view: this
      // narrows the acceptance author, it does not re-shape the tool for everyone.
      const seatRole = (team.members ?? []).find(m => m.id === caller.id)?.role;
      const exposeCandidate = seesCandidate(seatRole);
      const designTask = _args.design_task_id === undefined ? undefined : team.tasks.find(t => t.id === _args.design_task_id);
      if (_args.design_task_id !== undefined && !designTask) throw new Error(`unknown design task ${_args.design_task_id}`);
      const designContext = designTask ? taskDesignContext(team, designTask) : [];
      const p = team.protocol;
      const cycle = currentCycleOf(p);
      // One notion of 'blocking', shared with the gate: a MITIGATED P0/P1
      // still blocks completion, so it must not read as 'none' here.
      const openRisks = p.risks.filter(r => r.status === 'OPEN' || r.status === 'MITIGATED');
      const cacheTotal = p.stats.cacheHits + p.stats.cacheMiss;
      const acceptedCycles = p.cycles.filter(c => c.verify?.verdict === 'accept' && c.step === 'VERIFIED');
      const tasksDone = team.tasks.filter(t => t.status === 'completed').length;
      const coverage = goalCoverage(team);
      const disclosures = openDisclosures(team);
      // C3: the question "what may this task write?" has ONE answer, and it is
      // printed here. Before this, the proposal layer, the write guard and
      // integration each derived their own rule, so a team discovered the
      // divergence only at merge — measured: a probe was legal to propose and
      // legal to write, and integration refused the finished candidate.
      const effectiveScope = team.tasks.map(task => {
        const { envelope, allowed, source } = allowedWriteSet(task, p.cycles);
        // U2/#155: the same bypass, one field over. `allowed` mixes the task's declared envelope with
        // the files THIS cycle proposed (scope.js:100) — the implementer's answer — so the acceptance
        // seat keeps the declared envelope and the sealed oracle paths instead. It writes nothing but
        // its own oracle artifacts, so narrowing this costs it no capability.
        const writes = exposeCandidate ? allowed : [...new Set([...envelope, ...(task.oracle?.files ?? [])])];
        return { task_id: task.id, source, envelope, writes };
      });
      // The contract the team is judged by, printed rather than reconstructed:
      // which exit codes its frozen oracle declares as instrument failures.
      // Measured: every call site formed its own opinion about exit 2.
      const oracleExitSemantics = team.tasks
        .filter(task => task.oracle !== undefined)
        .map(task => ({ task_id: task.id, exit_semantics: exitSemantics(task.oracle) }));
      const gateCredentials = team.tasks.map(task => {
        const latest = latestGatePass(team, task.id);
        const boardCurrent = latest !== undefined
          && task.gatePassId === latest.id
          && latest.binding?.gateStateSha === gateStateFingerprint(team, task.id);
        return {
          task_id: task.id,
          latest_gate_pass_id: latest?.id ?? null,
          bound_gate_pass_id: task.gatePassId ?? null,
          board_state_current: boardCurrent,
        };
      });
      const pending = {};
      for (const m of team.members) {
        if (m.id === '' || m.status === 'removed') continue;
        pending[m.name] = (await readUnreadMailbox(stateRoot, team.id, m.name)).length;
      }
      // The obligation is computed once and reused: the [PAIR:NEXT] line, the stall
      // diagnosis and the blocking cause must describe the same debt, or a captain
      // reading two of them gets two answers. blockingCause answers "why is the owed
      // call still owed" with the same predicates the tools refuse with.
      const owed = nextObligation(team);
      const cause = blockingCause(team, { obligation: owed });
      const yields = yieldedObligations(team);
      const product = productSummary(team);
      const ordered = [...product.discoveries.filter(item => item.status === 'untriaged'),
        ...product.discoveries.filter(item => item.status !== 'untriaged').reverse()];
      product.total = ordered.length;
      product.offset = offset;
      product.next_offset = offset + limit < ordered.length ? offset + limit : null;
      product.discoveries = ordered.slice(offset, offset + limit);
      // The load ledger is what the GATE acts on, and the board was silent about it: a
      // captain could meet a credential refusal with no line above it to explain why.
      // Same reader, same violation rule the gate uses (ce-ledger.js).
      const ceLoads = await readCeLoads(stateRoot, Number(team.createdAt ?? 0));
      const summaryLines = [
        ...(designTask ? [`Design contract for ${designTask.id}: ${JSON.stringify(designContext)}`] : []),
        `Team "${team.name}" (${team.mode}, tdd=${team.tddMode ?? config.tddMode}, style=${team.pairStyle ?? config.pairStyle}) — phase ${p.phase}`,
        `Goal: ${team.goal}`,
        `Artifact root: ${oracleDirectory(team)}; scratch/probe root: ${scratchDirectory(team)}. Keep temporary files inside this run namespace.`,
        `Progress (working software is the only measure): ${acceptedCycles.length} accepted increment(s); ${tasksDone}/${team.tasks.length} task(s) done`,
        `Goal coverage: ${coverage.allocated}/${coverage.total} allocated · ${coverage.verified}/${coverage.total} executable · ${coverage.completed}/${coverage.total} completed${coverage.missingAllocation.length > 0 ? ` · MISSING ${coverage.missingAllocation.join(', ')}` : ''}`,
        `Members: ${team.members.map(m => `${m.name}(${m.role}:${m.status})`).join(', ')}`,
        ...(team.product ? [`Product backlog: ${product.untriaged} awaiting Captain triage; ${product.deferred} deferred; showing ${product.discoveries.length}/${product.total}, offset ${product.offset}${product.next_offset === null ? "" : `; next pair_status(product_offset=${product.next_offset})`}.`, ...product.discoveries.map(item => `${item.id} [${item.status}${item.priority ? `/priority ${item.priority}` : ''}]: ${item.observation} — ${item.userValue}`)] : []),
        ...team.tasks.filter(task => task.priority !== undefined || task.ready === false).map(task => `${task.id}: priority ${task.priority ?? 2}; ${task.ready === false ? 'draft, not claimable' : 'ready subject to dependencies/oracle'}; ${task.priorityReason ?? ''}`),
        ...(team.parallel ? [`Driver workspaces: ${Object.entries(team.parallel.slots).map(([name, slot]) => `${name}=${slot.path}`).join('; ')}`, `Integrated tasks: ${Object.keys(team.parallel.integrations ?? {}).join(', ') || '(none)'}`] : []),
        `Tasks: ${team.tasks.map(t => `${t.id}[${t.status}${t.assignee ? '@' + t.assignee : ''}${t.gatePassId ? ` gate=${t.gatePassId}` : ''}]`).join(', ') || 'none'}`,
        `Current cycle: ${cycle ? `${cycle.id}@${cycle.step}` : 'none'}`,
        obligationLine(owed),
        `Yielded obligations: ${yields.length === 0 ? 'none' : yields.map(y => `${y.tool}(${y.ref ?? '-'}) yielded by ${y.by}: ${y.reason}`).join(' · ')}`,
        `Blocking cause: ${cause === undefined ? 'nothing is owed' : `${cause.who} owes ${cause.tool}(${cause.ref ?? '-'})${cause.blocking.length === 0 ? '' : ' — ' + cause.blocking.join('; ')}. Suggested: ${cause.suggested_action}`}`,
        // One projection, three readers. pair_status, the board digest and the
        // scheduler's escalation all print THIS set, so a captain can never be
        // told one thing here and refused for another reason at pair_stop.
        attentionLines(attentionSet(team, { maxResumes: config.maxTokenResumes, candidateVisible: exposeCandidate })),
        (() => {
          const d = stallDiagnosis(team, { unread: pending, obligation: owed, blockingCause: cause });
          return d.stalled
            ? `STALLED: ${d.reason}. Nothing restarts a stopped seat except a message from you — send the owed call above, in this turn.`
            : `Liveness: ${d.reason}`;
        })(),
        `Awaiting a verdict: ${unverifiedCycles(p).map(c => `${c.id}@${c.step}`).join(', ') || 'none'} — a task may not open another cycle while one of its own is unverified`,
        `Oracle bypasses: ${p.cycles.filter(c => c.noOracleReason).map(c => `${c.id}: ${c.noOracleReason}`).join(' · ') || 'none'}`,
        // Goodhart's line, made visible. A computed verdict re-runs the sealed
        // command and therefore cannot see a product bent to fit it; this is
        // where the Driver's own declaration surfaces so a human, the retro
        // and the captain's final read all get to look at it.
        `Tuned to the instrument: ${p.cycles.filter(c => declares(c.green?.tunedForOracle)).map(c => `${c.id}: ${c.green.tunedForOracle}`).join(' · ') || 'nothing declared'}`,
        `Unresolved risks: ${openRisks.map(r => `${r.id}(${r.severity}/${r.status})`).join(', ') || 'none'} — a P0/P1 blocks completion until CLOSED (needs an executable artifact) or WONTFIX`,
        `Open disclosures: ${disclosureSummary(team)} — each needs a captain ruling before successful stop`,
        // Where the closed ones went. "Accepted as backlog" on a board with no
        // backlog is the failure this line exists to make visible.
        `Residual ledger: ${residualSummary(team)}`,
        ceStatusLine({ ...config, ceLoads: { ...ceLoads, violation: writeLaneViolation(ceLoads.loads) } }),
        // L2: name the skill that covers the call this team is actually owed, when the lane
        // serves it - and say nothing when no skill honestly matches.
        ...(ceMomentLine(config.ceLanes ?? 'off', owed?.tool) === undefined ? [] : [ceMomentLine(config.ceLanes ?? 'off', owed?.tool)]),
        // U1's lifecycle projection: which route each seat actually resolves to. Without
        // it a board can only be understood by reading the settings card, and a run on the
        // captain fallback is indistinguishable from a run with no override at all.
        (() => {
          const fallback = navRouteFallbackFor(team);
          const accept = fallback !== null
            ? 'CAPTAIN FALLBACK (' + fallback + ')'
            : (String(config.navigatorModel ?? '').trim() === '' ? 'composed default' : String(config.navigatorModel).trim());
          return 'Seat routes: navigator=' + accept + ' · spec=' + accept + ' · driver=composed default';
        })(),
        `Oracle: ${team.tasks.map(t => `${t.id}=${t.oracle === undefined ? 'NOT FROZEN' : oracleSummary(t.oracle)}`).join(' · ') || 'no tasks'}`,
        `Effective scope (what may be written, from protocol/scope.js): ${effectiveScope.map(s => `${s.task_id}=${s.source}${s.writes.length > 0 ? ':' + s.writes.join(',') : ':(nothing declared)'}`).join(' · ') || 'no tasks'}`,
        `Oracle exit codes: ${oracleExitSemantics.map(s => `${s.task_id} ${JSON.stringify(s.exit_semantics)}`).join(' · ') || 'none'}`,
        `Stats: noGo=${p.stats.noGo} reject=${p.stats.reject} attacks=${p.stats.attacks} reasons=${JSON.stringify(p.stats.reasons ?? {})} cache=${p.stats.cacheHits}/${cacheTotal || 1} hits`,
      ];
      const summary = summaryFor(seatRole, summaryLines);
      return {
        status_schema_version: 1,
        team_id: team.id, artifact_root: oracleDirectory(team), scratch_root: scratchDirectory(team),
        effective_scope: effectiveScope, oracle_exit_semantics: oracleExitSemantics,
        yielded_obligations: yields, blocking_cause: cause ?? null,
        ...(designTask ? { design_context: designContext } : {}),
        runtime_health: scheduler?.diagnostics?.() ?? null,
        summary,
        phase: p.phase,
        accepted_increments: acceptedCycles.length,
        tasks_done: tasksDone,
        // U2: the same projection as the summary. The acceptance author keeps the
        // contract and the board's shape, not the candidate's.
        cycles: exposeCandidate ? p.cycles : p.cycles.map(cycleExposure),
        // The same projection as `cycles`: this field was the one bypass around it (#155). The
        // acceptance seat must see the board's shape, never the candidate.
        current_cycle: cycle === undefined ? null : (exposeCandidate ? cycle : cycleExposure(cycle)),
        tasks: exposeCandidate ? team.tasks : team.tasks.map(task => taskExposure(task, _args.design_task_id)),
        product,
        members: team.members.map(({ persona, welcome, composition, ...m }) => ({ ...m, mailbox: { pending: pending[m.name] ?? 0 } })),
        ...(team.parallel ? { parallel: { workspaces: Object.fromEntries(Object.entries(team.parallel.slots).map(([name, slot]) => [name, slot.path])),
          integrations: team.parallel.integrations, pending: team.parallel.pending, integration_command: team.parallel.verificationCommand } } : {}),
        risks: p.risks,
        open_risks: openRisks,
        // #155/#156, third field of the same shape: a disclosure's free text IS candidate evidence —
        // for the tuned-to-the-instrument kind it is the Driver's own admission that the product was
        // shaped to fit its instrument. `text` is the field that carries it (not `why`, which this
        // projection named first and therefore missed), so the projection is a whitelist: the seat
        // keeps the ref, the kind and the subject, and a future free-text field cannot slip through.
        open_disclosures: exposeCandidate
          ? disclosures
          : disclosures.map(({ ref, kind, subject }) => ({ ref, kind, subject, text: 'candidate evidence — quoted to the captain only' })),
        attention_set: attentionSet(team, { maxResumes: config.maxTokenResumes, candidateVisible: exposeCandidate }).items,
        residual_ledger: residualLedger(team),
        gate_credentials: gateCredentials,
        recovery_actions: ['DONE', 'ABORTED'].includes(p.phase) ? [] : gateCredentials
          .filter(row => !row.board_state_current && team.tasks.some(t => t.id === row.task_id && t.status === 'completed'))
          .map(row => ({ tool: 'pair_gate_check', args: { task_id: row.task_id }, reason: 'Captain may re-certify a completed task, including in RETRO. Replays its oracle and current gate checks; does not waive missing review or override failures.' })),
        stats: p.stats,
        coverage,
        goal_coverage: coverage,
        use_cases: team.useCases ?? [],
        completion_receipt: p.completionReceipt ?? null,
        pending_note: 'mailbox.pending counts messages that are queued and not yet seen; a delivery claimed inside its 60s lease is excluded, so 0 can mean "in flight", not "delivered".',
      };
    },
  }));

  /* -------------------------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_stop',
    description: 'Close a team with an explicit outcome. outcome="complete" is a hard terminal gate: every goal criterion must be allocated, executable, and completed; every task must carry its exact gate pass; no P0/P1 or unruled disclosure remains; RETRO is done; and the plugin itself runs green_build_command (or configured dodCommand) fresh and observes exit 0. It returns a durable completion_receipt for the host goal. outcome="aborted" records an honest non-success terminal state and never issues a receipt.',
    parameters: {
      outcome: { type: 'string', description: 'complete (default) | aborted.' },
      reason: { type: 'string', description: 'Required for aborted; optional completion note for complete.' },
      green_build_command: { type: 'string', description: 'ONE runnable command line the plugin executes fresh, e.g. "npm test". Required for successful stop when no dodCommand is configured. A prose description is refused: this is executed, not read.' },
      green_build_evidence: { type: 'string', description: 'Deprecated note only; never treated as proof. Use green_build_command.' },
      force: { type: 'boolean', description: 'Deprecated compatibility alias for outcome="aborted"; it can never create DONE or a completion receipt.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Pair team "${v.team_id}" dissolved (${v.retired} member(s) retired).` }] },
    async execute(args, exec) {
      const captain = requireAgent(exec);
      const stateRoot = stateRootFor(captain, config);
      const team = await requireParticipantTeam(captain, config);
      if (!isCaptain(team, captain)) {
        throw new Error('only the captain can stop the team');
      }
      const requestedOutcome = args.force === true ? 'aborted' : (args.outcome ?? 'complete');
      if (requestedOutcome !== 'complete' && requestedOutcome !== 'aborted') throw new Error('pair_stop outcome must be complete or aborted');
      let greenRun;
      let measuredGreen = '';
      let finalWorktreeSha;
      if (requestedOutcome === 'complete' && config.greenBuildOnStop !== false) {
        const command = String(args.green_build_command ?? config.dodCommand ?? '').trim();
        // Executed verbatim below. Refusing prose here keeps a malformed
        // declaration from reading as "the suite is red" at the terminal gate.
        const greenShape = command === '' ? undefined : commandShapeError(command, { field: 'green_build_command' });
        if (greenShape !== undefined) throw new Error(greenShape);
        if (command === '') {
          throw new Error('COMPLETION_GATE_FAIL: successful stop needs a machine-run whole-suite command — pass green_build_command or configure dodCommand; green_build_evidence text is not proof');
        }
        greenRun = await runDodCommand({ ...config, dodCommand: command }, workspaceOf(captain), undefined, stateRoot);
        if (greenRun.skipped === true || greenRun.exit !== 0) {
          throw new Error(`COMPLETION_GATE_FAIL: green_build_command "${command}" exited ${String(greenRun.exit ?? 'skipped')}:\n${greenRun.outputTail ?? greenRun.reason ?? ''}`);
        }
        const tail = String(greenRun.output ?? '').split('\n').slice(-20).join('\n').trim();
        measuredGreen = `command: ${command}\nexit: 0${tail === '' ? '' : `\noutput tail:\n${tail}`}`;
      }
      if (requestedOutcome === 'complete') {
        finalWorktreeSha = await workspaceFingerprint(workspaceOf(captain), { stateDir: config.stateDir });
      }
      // The lock callback has its own scope, so the count is hoisted; the early
      // return above then correctly reports zero retirements.
      let retiredCount = 0;
      let terminalPhase;
      let completionReceipt;
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) return;
        if (fresh.protocol.phase === 'DONE' || fresh.protocol.phase === 'ABORTED') {
          throw new Error(`team "${fresh.id}" is already terminal (${fresh.protocol.phase})`);
        }
        const outcome = requestedOutcome;
        if (outcome === 'aborted') {
          const reason = String(args.reason ?? '').trim();
          if (reason === '') throw new Error('an aborted team needs a non-empty reason; otherwise failure is indistinguishable from success');
          fresh.protocol.abort = { reason, at: Date.now() };
          fresh.protocol.phase = 'ABORTED';
        } else {
          const evidence = measuredGreen || String(args.green_build_evidence ?? '').trim();
          const teamLedger = await readCeLoads(stateRoot, Number(fresh.createdAt ?? 0));
          const readiness = completionReadiness(fresh, {
            greenRequired: config.greenBuildOnStop !== false,
            greenEvidence: evidence,
            worktreeSha: finalWorktreeSha,
            ceLoads: { ...teamLedger, violation: writeLaneViolation(teamLedger.loads) },
          });
          if (!readiness.ready) {
            throw new Error(`COMPLETION_GATE_FAIL:\n- ${readiness.failures.join('\n- ')}\nUse outcome="aborted" with a reason to dissolve without claiming success.`);
          }
          fresh.protocol.greenBuild = { evidence, at: Date.now() };
          completionReceipt = makeCompletionReceipt(fresh, evidence);
          fresh.protocol.completionReceipt = completionReceipt;
          fresh.protocol.phase = 'DONE';
        }
        terminalPhase = fresh.protocol.phase;
        for (const member of fresh.members) {
          if (member.id === '' || member.status === 'removed') continue;
          member.status = 'removed';
          member.retiredAt = Date.now();
        }
        await writeTeam(stateRoot, fresh);
        retiredCount = (await retireSpawnedMembers(ctx, captain, stateRoot, fresh.members)).retired.length;
        scheduler?.untrackTeam?.(workspaceOf(captain), fresh.id);
        // Hand back everything the scheduler held on this team's behalf: the
        // per-seat maps are keyed by child session id, and a stopped team's
        // ids are dead.
        scheduler?.releaseTeamSeats?.((fresh.members ?? []).map((m) => m.id), fresh.id);
        appendPairEvent(ctx, captain.session, 'pair/team-deleted', { teamId: fresh.id, reason: args.reason });
      });
      // Keep the state dir for audit; removing the live record's dir would lose the log.
      return { team_id: team.id, retired: retiredCount, phase: terminalPhase, completion_receipt: completionReceipt ?? null, green_build: greenRun ?? null,
        ...(team.parallel ? { preserved_workspaces: Object.values(team.parallel.slots).map(slot => slot.path) } : {}) };
    },
  }));

  /* -------------------------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_interrupt',
    description: 'Captain only: ISSUE a cancel signal for one member turn, then stop the sweep from reviving that run until you speak again. The host is fire-and-return — "the target may keep running until it observes the signal" (dsh-subagent types/index.d.ts:146-152) — so a member inside a long tool call can finish that call first; check pair_status before assuming it stopped. This is a PAUSE, not a terminal stop: any later delivery resumes the seat. The sweep stops synchronously, but a heartbeat pass already in flight keeps the snapshot it took at its start, so at most ONE further nudge can slip through in that window; after it, nothing wakes the run until you speak. A guard against that window would have to distinguish this sweeps nudges from the deliberate kicks tools make (`pair_task_create`), so it is named here rather than forced. By default this also clears that child\'s host inbox and acknowledges its unread pair mailbox, so stale instructions cannot flood the next turn. Pass discard_queued=false only when the queued work is still valid.',
    parameters: {
      member: { type: 'string', required: true, description: 'Member name whose current turn should stop (e.g. "driver").' },
      reason: { type: 'string', required: true, description: 'Why the turn is cancelled; required so the control is never unexplained.' },
      discard_queued: { type: 'boolean', description: 'Clear queued host and pair-mailbox work (default true).' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: (v.delivered
        // Fire-and-return is the host's contract, so "interrupted" would overclaim: the
        // signal is issued and the sweep is stopped, but the member may finish its current
        // step first. Say which of the two actually happened.
        ? `Cancel signal issued for ${v.interrupted} (${v.reason}); this run will not be woken again until you speak. `
          + (v.turn === 'mid_turn' ? 'The seat was mid-turn when the signal went out, so it may still finish that step — check pair_status; pressing again is safe.'
            : v.turn === 'idle' ? 'The seat was idle, so there was no turn to stop.'
            : 'No live session was available to inspect, so read pair_status before assuming it stopped.')
        : `The cancel signal for ${v.interrupted} could not be delivered — that member may still be running (${v.reason}).`) + ` Discarded ${v.discarded ?? 0} queued pair message(s).` }] },
    async execute(args, exec) {
      const captain = requireAgent(exec);
      const stateRoot = stateRootFor(captain, config);
      const team = await requireParticipantTeam(captain, config);
      if (!isCaptain(team, captain)) throw new Error('only the captain can interrupt a member');
      const reason = String(args.reason ?? '').trim();
      if (reason === '') throw new Error('pair_interrupt needs a reason — an unexplained cancellation cannot be audited');
      let interrupted;
      let delivered = false;
      let discarded = 0;
      // Fire-and-return means "delivered" cannot say whether a turn actually stopped. The live
      // status can, so the captain learns whether one press was enough. Measured on SG-career:
      // the first press and the second produced identical receipts, one of which did not stop
      // anything, and the only way to tell was to read the board afterwards.
      let turn = null;
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        const wanted = String(args.member ?? '').trim();
        const member = fresh.members.find(m => m.name === wanted && m.status !== 'removed');
        if (member === undefined) throw new Error(`no active member named "${wanted}" in team "${fresh.id}"`);
        if (member.id === '') throw new Error(`member "${member.name}" has no live session to interrupt`);
        const live = ctx.agents?.get?.(member.id);
        turn = live === undefined ? null : live.status === 'idle' ? 'idle' : 'mid_turn';
        if (args.discard_queued !== false) {
          try { live?.cancel?.({ kind: 'parent' }); } catch (error) {
            ctx.logger?.warn?.(`pair-programming: host inbox clear for ${member.id} failed: ${String(error)}`);
          }
          discarded = await discardUnreadMailbox(stateRoot, fresh.id, member.name);
        }
        delivered = interruptMember(ctx, captain, member.id);
        interrupted = member.name;
        // A cancelled turn is not a pause. The SDK documents that a later WAKING SEND
        // resumes the parked child, and the heartbeat sweep exists to nudge whoever owes a
        // call — so without this the sweep restarts the very seat the captain just stopped
        // (reported live, 2026-09-11: "driver 不会停，回来后又自己跑上了"). Untracking adds
        // no board state and no new field: any delivery re-tracks the run, so the pause
        // lasts exactly until the captain speaks again.
        scheduler?.untrackTeam?.(workspaceOf(captain), fresh.id);
        appendPairEvent(ctx, captain.session, 'pair/interrupted', { teamId: fresh.id, memberId: member.id, name: member.name, reason });
      });
      return { interrupted, reason, delivered, discarded, turn, discard_queued: args.discard_queued !== false };
    },
  }));

  /* -------------------------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_retro',
    description: 'Captain only: run the Sprint Retrospective when all tasks are terminal — inspect the process (rejected cycles by reason, missed risks, granularity, style fit, protocol stats), record keep/try action items. Writes retro.md, stores the keep/try lessons for the NEXT session to inherit, and moves the phase to RETRO. Do this before pair_stop.',
    parameters: {
      keep: { type: 'array', items: { type: 'string' }, description: 'What worked — the team should keep doing. Archived in retro.md; not carried across sessions.' },
      try: { type: 'array', description: 'What to try next session. A bare string is archived in retro.md only. To CARRY an entry into future sessions (where every session and every recycled seat re-reads it), give an object: {lesson, counterfactual (what recurs or must be re-investigated if this is deleted), reuse_trigger (what a future session would be doing when it needs this), evidence[] (cycle/risk/file/command it came from), rederivable_from (optional — if the repo already says it, name the source and it stays archived).' },
      notes: { type: 'string', description: 'Retrospective narrative: rejected cycles and why, missed risks, granularity assessment.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Retro written: ${v.keep_count} keep, ${v.try_count} try; lessons carried to the next session.` }] },
    async execute(args, exec) {
      const captain = requireAgent(exec);
      const stateRoot = stateRootFor(captain, config);
      const team = await requireParticipantTeam(captain, config);
      if (!isCaptain(team, captain)) throw new Error('only the captain can run the retrospective');
      const keep = (args.keep ?? []).map(s => String(s).trim()).filter(Boolean);
      const proposed = (args.try ?? []).filter(item => item !== undefined && item !== null);
      if (keep.length + proposed.length === 0) {
        throw new Error('a retro without action items is theater — record at least one keep or try item');
      }
      // V5.4: two destinations. retro.md takes everything and costs nothing
      // later; the cross-session store is a prompt input that every future
      // session and every recycled seat re-reads, so an entry earns a place
      // there by answering the counterfactual, not by being written down.
      const maxCarried = config.maxCarriedLessons ?? DEFAULT_MAX_CARRIED;
      const admission = admitLessons(proposed, { max: maxCarried });
      if (admission.overflow.length > 0) {
        throw new Error(`RETRO_CARRY_OVERFLOW: ${overflowRefusal(admission, maxCarried)}`);
      }
      const retroPath = join(teamDirOf(stateRoot, team.id), 'retro.md');
      const lessons = { at: Date.now(), teamId: team.id, keep, try: admission.carried };
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        const p = fresh.protocol;
        const nonTerminal = fresh.tasks.filter(task => !['completed', 'failed', 'cancelled'].includes(task.status));
        if (fresh.tasks.length === 0 || nonTerminal.length > 0) {
          throw new Error(`RETRO_NOT_READY: every task must be terminal first${fresh.tasks.length === 0 ? ' (the board is empty)' : `; still open: ${nonTerminal.map(task => `${task.id}[${task.status}]`).join(', ')}`}`);
        }
        const cacheTotal = p.stats.cacheHits + p.stats.cacheMiss;
        const text = [
          `# Retrospective — ${fresh.name} (${fresh.mode}, tdd=${fresh.tddMode ?? config.tddMode}, style=${fresh.pairStyle ?? config.pairStyle})`,
          `Goal: ${fresh.goal}`,
          `Phase: ${p.phase} — ${new Date().toISOString()}`,
          '',
          '## Protocol stats (retrospective > post-mortem: improve while the project can still benefit)',
          `- accepted increments: ${p.cycles.filter(c => c.verify?.verdict === 'accept').length} / cycles opened: ${p.cycles.length}`,
          `- no_go: ${p.stats.noGo} · reject: ${p.stats.reject} · attacks: ${p.stats.attacks} · gate fails: ${p.stats.gateFails ?? 0}`,
          `- rejection reasons: ${JSON.stringify(p.stats.reasons ?? {})}`,
          `- evidence cache: ${p.stats.cacheHits}/${cacheTotal || 1} hits`,
          '',
          '## Keep',
          ...keep.map(k => `- ${k}`),
          '',
          '## Try next session — carried into future sessions',
          ...(admission.carried.length === 0 ? ['- (nothing met the carry bar; everything below stays in this archive)'] : []),
          ...admission.carried.map(item => [
            `- ${item.lesson}`,
            `  - if deleted: ${item.counterfactual}`,
            `  - recall when: ${item.reuseTrigger}`,
            `  - evidence: ${item.evidence.join(', ')}`,
          ].join('\n')),
          '',
          ...(admission.archived.length === 0 ? [] : [
            '## Archived here only — did not meet the carry bar',
            ...admission.archived.map(item => `- ${item.lesson}\n  - why not carried: ${item.why}`),
            '',
          ]),
          args.notes ? `## Notes\n${args.notes}` : '',
        ].filter(line => line !== false).join('\n');
        await atomicWriteText(retroPath, text);
        fresh.protocol.phase = 'RETRO';
        fresh.processLessons = lessons;
        await writeTeam(stateRoot, fresh);
        appendPairEvent(ctx, captain.session, 'pair/retro', {
          teamId: fresh.id, keep, try: admission.carried.map(lessonLine), archived: admission.archived.length,
        });
        await atomicWriteText(lessonsFileOf(stateRoot), JSON.stringify(lessons, null, 2));
      });
      return {
        retro_file: retroPath,
        keep_count: keep.length,
        try_count: admission.carried.length,
        carried: admission.carried.map(lessonLine),
        archived: admission.archived,
        carry_note: `${admission.carried.length} entr(y/ies) carried into future sessions; ${admission.archived.length} archived in retro.md only. Everything is recorded — only what answers the counterfactual is re-read by every future session.`,
      };
    },
  }));

  /* -------------------------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_rotate',
    description: 'Rotate the Driver role: hand the single-writer role to another member with a handoff note (progress / open risks / next steps / pitfalls), and optionally set the pairing style going forward (traditional / strong / ping-pong). Rotate on a cadence — nobody pairs for hours straight; alternation spreads knowledge and raises the team\'s truck factor. Captain only. [Currently refused in 0.3.x — capabilities are bound at spawn time; dissolve the team with pair_stop and restart it with the roles you want].',
    parameters: {
      new_driver: { type: 'string', required: true, description: 'Member name taking over as Driver.' },
      handoff_note: { type: 'string', required: true, description: 'Progress / open risks / next steps / pitfalls for the incoming Driver.' },
      style: { type: 'string', description: 'Optional new pairing style for the team after rotation.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Driver role rotated to "${v.new_driver}".` }] },
    async execute(args, exec) {
      const captain = requireAgent(exec);
      const stateRoot = stateRootFor(captain, config);
      const team = await requireParticipantTeam(captain, config);
      if (!isCaptain(team, captain)) throw new Error('only the captain can rotate the Driver role');
      throw new Error(`pair_rotate is refused in 0.3.x: member capabilities are bound at spawn time, so a rotation would leave the incoming Driver denied of write/edit while the outgoing Driver keeps them — I1 inverted both ways. The real fix is the dynamic write guard (M2'); until then dissolve the team with pair_stop and start it with the roles you want.`);
      if (args.style !== undefined && !PAIR_STYLES.includes(args.style)) {
        throw new Error(`unknown pairing style "${args.style}" (traditional | strong | ping-pong)`);
      }
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        const incoming = fresh.members.find(m => m.name === args.new_driver && m.status !== 'removed');
        if (incoming === undefined) throw new Error(`no active member named "${args.new_driver}"`);
        const currentDriver = fresh.members.find(m => m.role === 'driver' && m.status !== 'removed');
        if (incoming.role === 'driver') throw new Error(`"${args.new_driver}" is already the Driver`);
        if (currentDriver !== undefined) currentDriver.role = incoming.role; // the old Driver inherits the incoming's former role
        incoming.role = 'driver';
        if (args.style !== undefined) fresh.pairStyle = args.style;
        await writeTeam(stateRoot, fresh);
        appendPairEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'pair/rotated', {
          teamId: fresh.id, newDriver: incoming.name, style: args.style, handoff: args.handoff_note,
        });
      });
      await deliverProtocolMessage(ctx, config, captain, team, args.new_driver,
        encodeMessage('HANDOFF', {
          progress: args.handoff_note, open_risks: [], next_steps: 'see handoff note', pitfalls: 'see handoff note',
        }), exec);
      return { new_driver: args.new_driver };
    },
  }));
}
