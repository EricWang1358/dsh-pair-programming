/**
 * SPEC-FORK (N1): `pair_oracle` — the Navigator freezes the acceptance oracle
 * from the request alone, before the Driver has an approach to defend.
 *
 * This is the only step in the protocol that manufactures information the
 * implementer does not already hold, so it is deliberately the cheapest one:
 * request-sized context, one turn, no repository sweep.
 *
 * @module dsh-pair-programming/tools/oracle
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { withLock } from '../state/lock.js';
import { stateRootFor, workspaceOf, requireAgent, requireParticipantTeam, deliverProtocolMessage } from './shared.js';
import { teamLockKey } from '../state/layout.js';
import { readTeam, writeTeam } from '../state/store.js';
import { atomicWriteText } from '../state/atomic.js';
import { encodeMessage } from '../protocol/messages.js';
import { forkProblems, redProblem, freezeRecord, oracleSummary, reachWarning, nonGatingProblems, boundedRedTail } from '../protocol/oracle.js';
import { commandShapeError, exitSemantics, instrumentExitCodeProblem, normalizeInstrumentExitCodes } from '../protocol/command-shape.js';
import { assertTaskOracleFiles, assessOracleReach, digestOracleFiles, resolveTaskOracleFile, runOracleCommand, oracleSyntaxProblem, draftSyntaxProblem, artifactMetrics } from './oracle-exec.js';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { appendPairEvent, captainSessionOf } from '../events.js';
import { oracleCoverageProblems } from '../protocol/coverage.js';
import { oraclePreparationWindow } from '../protocol/obligation.js';
import { captureEvidenceBoundary, assertEvidenceBoundary, requireProductRun, requireLiveEvidenceTarget, checkCancellation } from './verification-boundary.js';
import { taskWorkspace } from '../runtime/workspace-context.js';
import { driverForTask } from '../runtime/parallel-tasks.js';

function assertPreparationWindow(team, taskId, freezing = false) {
  if (team.tasks.find(task => task.id === taskId)?.ready === false) throw new Error('TASK_NOT_READY: product triage must allocate this draft before QA authors its oracle');
  const window = oraclePreparationWindow(team, taskId);
  if (team.parallel && window.paused) throw new Error(`TASK_NOT_CLAIMED: the owning Driver must call pair_task_claim for "${taskId}" before QA writes or freezes its isolated oracle; no need to wait for another task`);
  if (freezing && window.future) throw new Error(`wait for current canonical task "${window.currentTaskId}" to become terminal before freezing or executing a future oracle command`);
  if (window.paused) throw new Error(`oracle preparation paused: current canonical task "${window.currentTaskId}" has a candidate under verification; wait until it is terminal before writing future oracle files`);
}

export function registerOracleTools(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'pair_oracle_write',
    description: 'Navigator only: write one acceptance-test artifact before freezing it. This is the Navigator\'s only workspace write capability; path must be under the current team artifact_root from pair_status, followed by <task_id>/, never production source.',
    parameters: {
      task_id: { type: 'string', required: true },
      path: { type: 'string', required: true, description: 'Path under the current team artifact_root from pair_status, followed by <task_id>/.' },
      content: { type: 'string', required: true, description: 'UTF-8 test artifact content (maximum 1 MiB).' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Oracle artifact written: ${v.path}` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const team = await requireParticipantTeam(agent, config);
      const stateRoot = stateRootFor(agent, config);
      // Serialize validation THROUGH the file commit with GREEN/report/gate.
      // Excluding future oracle paths from the candidate digest would hide
      // possible read dependencies instead of preventing the race.
      return withLock(teamLockKey(stateRoot, team.id), async () => {
        checkCancellation(exec.signal);
        const fresh = await readTeam(stateRoot, team.id);
        const { member } = requireLiveEvidenceTarget(fresh, args.task_id, agent);
        const writer = fresh.mode === 'solo' ? 'spec' : 'navigator';
        if (member?.role !== writer) throw new Error(`only the ${writer === 'spec' ? 'SPEC seat' : 'Navigator'} can write an oracle artifact (you are ${member?.role ?? 'not a member'})`);
        if (fresh.protocol.cycles.some(c => c.taskId === args.task_id && c.verify?.verdict === 'accept')) {
          throw new Error(`task "${args.task_id}" already has an accepted cycle — its oracle artifacts are immutable`);
        }
        assertPreparationWindow(fresh, args.task_id);
        const workspace = taskWorkspace(fresh, args.task_id, workspaceOf(agent));
        if (Buffer.byteLength(args.content, 'utf8') > 1024 * 1024) throw new Error('oracle artifact exceeds the 1 MiB limit');
        const target = resolveTaskOracleFile(workspace, args.task_id, args.path, fresh);
        // G1: an artifact that does not parse cannot become a standard, and the seat
        // writing it has no shell to notice. Refused here, before it replaces a good
        // draft; the parse runs on the author's own file, so an oracle that asserts a
        // SyntaxError in the code under test is untouched.
        const brokenDraft = await draftSyntaxProblem(args.path, args.content);
        if (brokenDraft !== undefined) {
          throw new Error(`${brokenDraft}\n\nNothing was written. Fix the artifact and write it again: a file that cannot be parsed fails its RED run for a reason unrelated to the code under test, and it would keep failing the same way at every later verdict.`);
        }
        await mkdir(dirname(target), { recursive: true });
        checkCancellation(exec.signal);
        await atomicWriteText(target, args.content);
        return { task_id: args.task_id, path: args.path, bytes: Buffer.byteLength(args.content, 'utf8') };
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'pair_oracle',
    description: 'Navigator only, BEFORE the Driver implements (SPEC-FORK): freeze the acceptance oracle for one task, derived from the REQUEST ALONE — do not read the Driver\'s approach, and do not survey the repository for how it happens to be built today. Supply (1) readings[]: at least two genuinely different interpretations the request permits, each with the behaviour that distinguishes it; (2) chosen_reading: the one this oracle encodes, verbatim from readings[]; (3) divergence_candidates[]: how a hidden acceptance test could disagree with your choice — this is the adversarial duty, and it must be closed with evidence, not opinion; (4) oracle_files[] + oracle_cmd: the acceptance test and how to run it. The tool RUNS the command and refuses the freeze unless it fails today (an oracle that already passes asserts nothing). On success the file set is sealed under a digest: it becomes the cycle\'s RED, and any later edit to it is caught at verification.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The task this oracle accepts.' },
      readings: { type: 'array', items: { type: 'string' }, required: true, description: 'At least two distinct interpretations of the request, each naming the behaviour that would distinguish it.' },
      chosen_reading: { type: 'string', required: true, description: 'The reading this oracle encodes — verbatim one of readings[].' },
      divergence_candidates: { type: 'array', items: { type: 'string' }, required: true, description: 'How a hidden acceptance test could disagree with the chosen reading.' },
      oracle_files: { type: 'array', items: { type: 'string' }, required: true, description: 'Acceptance test paths under the current team artifact_root from pair_status, followed by <task_id>/, written through pair_oracle_write.' },
      oracle_cmd: { type: 'string', required: true, description: 'ONE runnable command line that runs the acceptance test, e.g. "node tests/acceptance.mjs". It must FAIL right now, and it is re-executed verbatim at every later verdict — so a prose plan or a mistyped program name seals into the task contract and then "fails" forever for a reason that has nothing to do with the code.' },
      expected_failure: { type: 'string', description: 'The failure signature you expect today, in your own words.' },
      instrument_exit_codes: { type: 'array', items: { type: 'number' }, description: 'Exit codes that mean the MEASUREMENT failed, not the code — e.g. [2] for a runner that exits 2 when a prerequisite is missing. Declaring one makes that exit produce no product verdict, no failure count and a retry hint at the freeze, verify, gate, integrate and stop steps; 0 is success and cannot be declared. Every undeclared exit code stays a verdict about the code, which is the default.' },
      case_refs: { type: 'array', items: { type: 'string' }, description: 'Every UC-N.AC-N allocated to this task that the executable oracle covers. Missing or foreign refs are rejected.' },
      fork_kind: { type: 'string', description: 'interpretation (default) | defect. A defect correction needs defect_evidence and does not consume the interpretation-divergence budget.' },
      defect_evidence: { type: 'string', description: 'Required when fork_kind=defect: concrete failing/false-positive evidence showing the prior oracle itself was invalid.' },
      captain_override: { type: 'string', description: 'One-line rationale required to fork past the oracleForkBudget (default 3). Recorded on the freeze — a fork that has to be argued for is one less fork you take by reflex.' },
      non_gating_arms: { type: 'array', items: { type: 'string' }, description: 'Arms this oracle computes and prints but which must NOT decide the verdict yet — a declared blind spot. Sealing with known-red arms is a supported move: it beats holding the whole team behind an oracle that is right about everything. Requires non_gating_reason.' },
      non_gating_reason: { type: 'string', description: 'Why each non-gating arm cannot gate this task yet, and which task or card carries it as a hard gate instead.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `Oracle frozen for ${v.task_id}: ${v.summary}` }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const stateRoot = stateRootFor(agent, config);
      const team = await requireParticipantTeam(agent, config);
      const member = team.members.find(m => m.id === agent.id && m.status !== 'removed');
      const author = team.mode === 'solo' ? 'spec' : 'navigator';
      if (member?.role !== author) {
        throw new Error(`only the ${author === 'spec' ? 'SPEC seat' : 'Navigator'} freezes the oracle (you are ${member?.role ?? 'not a member'}) — the point is that its author has not seen the implementation, which in solo mode is guaranteed by that seat holding no reader and no shell`);
      }
      const task = team.tasks.find(t => t.id === args.task_id);
      if (task === undefined) throw new Error(`unknown task "${args.task_id}"`);
      assertPreparationWindow(team, args.task_id, true);
      const workspace = taskWorkspace(team, args.task_id, workspaceOf(agent));
      if (team.protocol.cycles.some(c => c.taskId === args.task_id && c.verify?.verdict === 'accept')) {
        throw new Error(`task "${args.task_id}" already has an accepted cycle — re-freezing the oracle after acceptance would rewrite the standard the work was judged against`);
      }
      // Freeze budget with an escape hatch. Measured failure: a single oracle
      // was re-forked six-plus times over 2h 16min, each fork valid, the set
      // divergent. A soft cap surfaces the pattern; captain_override names the
      // escape so wrong lists still stop but real progress does not.
      const budget = config.oracleForkBudget ?? 3;
      // Which KIND of fork this is decides whether it may cross an in-flight cycle,
      // so it is settled before that question is asked.
      const defectFix = args.fork_kind === 'defect';
      if (args.fork_kind !== undefined && args.fork_kind !== 'interpretation' && args.fork_kind !== 'defect') {
        throw new Error('fork_kind must be interpretation or defect');
      }
      // An in-flight cycle carries a stamp of the seal it was opened against.
      // Re-forking under it would leave the Driver working to one standard and
      // being judged by another, so the cycle must finish or be abandoned first.
      // A rejected cycle at its rewind point may re-fork. Its old reject
      // field survives a fresh GREEN/report, so the verdict alone cannot tell
      // whether the Driver has already started repairing it.
      //
      // A DEFECT fork is the exception (G3), and the reason this rule cannot be
      // absolute. That fork exists precisely when the sealed standard is invalid — and
      // an invalid standard is not one the Driver is "working to", it is one that
      // measures nothing. Refusing here locked the instrument: the only way to re-freeze
      // was to drive an unsatisfiable standard to a verdict first, spending a cycle on
      // a measurement nobody could pass. The repaired seal is written onto the in-flight
      // cycle below, with the replaced digest recorded on it, so the Driver continues
      // under a standard that is now valid and the repair is visible on the board.
      const inFlight = team.protocol.cycles.find(c => c.taskId === args.task_id && c.step !== 'VERIFIED' && c.step !== 'CLOSED'
        && !(c.verify?.verdict === 'reject' && ['GO', 'PROPOSED'].includes(c.step)));
      if (inFlight !== undefined && team.tasks.find(t => t.id === args.task_id)?.oracle !== undefined && !defectFix) {
        throw new Error(`cycle ${inFlight.id} is in flight at step ${inFlight.step} against the current oracle — re-forking now would judge the Driver by a standard it was never shown. Let the cycle reach a verdict first (a REJECT is fine), then re-freeze. If instead the SEAL ITSELF is invalid, re-freeze with fork_kind="defect" and the evidence that shows the old standard could not be satisfied.`);
      }
      if (defectFix && String(args.defect_evidence ?? '').trim() === '') {
        throw new Error('fork_kind="defect" requires defect_evidence: the concrete failing or false-positive evidence showing the prior oracle itself was invalid. A defect fork skips the interpretation-divergence budget and may now cross an in-flight cycle, so the claim has to be on the record.');
      }
      const forksSoFar = task.oracle?.interpretationForks ?? task.oracle?.forks ?? 0;
      if (!defectFix && forksSoFar >= budget && String(args.captain_override ?? '').trim() === '') {
        throw new Error(`task "${args.task_id}" has been frozen ${forksSoFar} time(s), at or over the budget of ${budget}. Re-forking without a stated reason is how an oracle set diverges — one measured team re-froze six times in 2h 16min while producing zero code. Two supported ways forward: (1) declare the still-red arms non_gating with a reason and seal the oracle as-is (the arms print and route to their real cards); (2) if you genuinely need another fork, pass captain_override with a one-line rationale that will be recorded on the freeze.`);
      }

      const problems = [...forkProblems(args), ...nonGatingProblems(args), ...oracleCoverageProblems(task, args.case_refs)];
      if (problems.length > 0) {
        throw new Error(`the SPEC-FORK is incomplete:\n- ${problems.join('\n- ')}`);
      }

      // Before the RED run, not after: the freeze gate demands a FAILING
      // command, so it cannot itself tell a real red from an unrunnable one.
      const cmdShape = commandShapeError(args.oracle_cmd, { field: 'oracle_cmd' });
      if (cmdShape !== undefined) throw new Error(cmdShape);

      const exitProblem = instrumentExitCodeProblem(args.instrument_exit_codes);
      if (exitProblem !== undefined) throw new Error(exitProblem);
      const declaredInstruments = normalizeInstrumentExitCodes(args.instrument_exit_codes);
      assertTaskOracleFiles(args.task_id, args.oracle_files, team);
      // G1: the freeze gate demands a FAILING command, so it cannot tell a real red
      // from a program that never got past its own syntax — that standard would fail
      // identically at every later verdict while no implementation could ever turn it
      // green. Parse first, seal second.
      const brokenArtifact = await oracleSyntaxProblem(workspace, args.oracle_files);
      if (brokenArtifact !== undefined) {
        throw new Error(`VERIFICATION_INFRASTRUCTURE: ${brokenArtifact}\n\nNo verdict was recorded and nothing was sealed. A parse error fails the RED run for a reason unrelated to the code under test, so this freeze cannot describe acceptance — fix the artifact, then freeze again.`);
      }
      const boundary = await captureEvidenceBoundary(team, task.id, agent, config, exec.signal);

      // Digest first, then run: the seal must describe the bytes that produced
      // the RED, not whatever the command may have rewritten on its way.
      const sha = await digestOracleFiles(workspace, args.oracle_files);
      const run = await runOracleCommand(workspace, args.oracle_cmd, { signal: exec.signal, instrumentExitCodes: declaredInstruments });
      requireProductRun(run, exec.signal);
      await assertEvidenceBoundary(boundary, await readTeam(stateRoot, team.id), agent, config, exec.signal);
      if (await digestOracleFiles(workspace, args.oracle_files) !== sha) throw new Error('VERIFICATION_STALE: oracle files changed during their RED run');
      const notRed = redProblem(run);
      if (notRed !== undefined) {
        throw new Error(`${notRed}\n\ncommand: ${run.command}\nexit: ${String(run.exit)}\noutput tail:\n${run.outputTail}`);
      }

      const reach = await assessOracleReach(workspace, args.oracle_files);
      // G4/G5: the freeze reports what it sealed, not only a digest, and it says which
      // KIND of freeze this is and how much interpretation budget is left. Both are
      // recorded, so pair_status shows them without recomputing anything.
      const metrics = await artifactMetrics(workspace, args.oracle_files);
      const forks = (task.oracle?.forks ?? 0) + 1;
      const record = freezeRecord(args, { sha, run, by: member.name, reach, forks });
      record.supersededRejections = [...(task.oracle?.supersededRejections ?? [])];
      record.supersededCheckpoints = [...(task.oracle?.supersededCheckpoints ?? [])];
      record.interpretationForks = (task.oracle?.interpretationForks ?? task.oracle?.forks ?? 0) + (defectFix ? 0 : 1);
      if (declaredInstruments.length > 0) record.instrumentExitCodes = declaredInstruments;
      if (defectFix) record.defectEvidence = String(args.defect_evidence).trim();
      if (String(args.captain_override ?? '').trim() !== '') record.captainOverride = String(args.captain_override).trim();
      record.metrics = metrics;
      // How many interpretation forks this board has left before the budget refuses
      // one without a captain override. Printed at the freeze so nobody has to
      // reverse-engineer it from a refusal later (G5).
      record.budgetRemaining = Math.max(0, budget - record.interpretationForks);
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        const target = fresh.tasks.find(t => t.id === args.task_id);
        if (target === undefined) throw new Error(`unknown task "${args.task_id}"`);
        assertPreparationWindow(fresh, args.task_id, true);
        await assertEvidenceBoundary(boundary, fresh, agent, config, exec.signal);
        const freshMember = fresh.members.find(m => m.id === agent.id && m.status !== 'removed');
        if (freshMember?.role !== author) throw new Error('VERIFICATION_STALE: oracle author no longer holds the required seat');
        if (await digestOracleFiles(workspace, args.oracle_files) !== sha) throw new Error('VERIFICATION_STALE: oracle files changed before the freeze committed');
        for (const cycle of fresh.protocol.cycles) {
          if (cycle.taskId !== task.id) continue;
          const rejected = cycle.verify?.verdict === 'reject' && ['GO', 'PROPOSED'].includes(cycle.step);
          const checkpoint = cycle.step === 'VERIFIED' && cycle.verify?.verdict === 'checkpoint'
            && cycle.verify.computed === true && cycle.verify.oracleSha === cycle.oracleSha;
          // G3: an OPEN cycle whose seal was just proven invalid keeps its work and its
          // step; only its stamp moves, and the replacement is recorded on the cycle.
          // Leaving the old stamp would strand it: the frontier refuses a cycle whose
          // digest disagrees with the task's oracle, and resolveCycleOracle refuses it
          // too, so the repair itself would become the deadlock it exists to remove.
          if (defectFix && !rejected && !checkpoint && cycle.step !== 'CLOSED'
            && typeof cycle.oracleSha === 'string' && cycle.oracleSha !== sha) {
            cycle.oracleRepair = { fromOracleSha: cycle.oracleSha, oracleSha: sha, at: record.frozenAt, by: freshMember.name,
              ...(record.defectEvidence === undefined ? {} : { defectEvidence: record.defectEvidence }) };
            cycle.oracleSha = sha;
            continue;
          }
          if (!rejected && !checkpoint) continue;
          const closure = { reason: 'oracle-replaced', fromOracleSha: cycle.oracleSha, oracleSha: sha, at: record.frozenAt, by: freshMember.name };
          cycle.closure = closure;
          cycle.step = 'CLOSED';
          (rejected ? record.supersededRejections : record.supersededCheckpoints).push({ cycleId: cycle.id, ...closure });
        }
        target.oracle = record;
        target.updatedAt = Date.now();
        await writeTeam(stateRoot, fresh);
      });

      appendPairEvent(ctx, captainSessionOf(ctx, team.captainSessionId, agent.session), 'pair/oracle-frozen', {
        teamId: team.id, taskId: args.task_id, sha, cmd: record.cmd, readings: record.readings.length,
      });

      const body = {
        task_id: args.task_id, oracle_sha: sha, oracle_cmd: record.cmd,
        ...(team.parallel ? { workspace } : {}),
        oracle_files: record.files, chosen_reading: record.chosen,
        divergence_candidates: record.divergences,
        case_refs: record.caseRefs,
        exit_semantics: exitSemantics(record),
        // #15: the tail is a diagnostic the frozen command reproduces. Bounded, with the
        // elision stated, rather than 50% of every freeze letter.
        red_exit: run.exit, red_tail: boundedRedTail(run.outputTail, record.redSignature),
        freeze: { number: record.forks, kind: record.forkKind, interpretation_forks_left: record.budgetRemaining,
          ...(record.defectEvidence === undefined ? {} : { reason: record.defectEvidence }) },
        artifact_metrics: metrics,
        ...(reachWarning(record) === undefined ? {} : { reach_warning: reachWarning(record) }),
        note: 'This oracle is frozen. Do not edit its files: verification recomputes the digest and a changed oracle is an automatic REJECT.',
      };
      const driver = await deliverProtocolMessage(ctx, config, agent, team, driverForTask(team, args.task_id), encodeMessage('ORACLE', body), exec);
      await deliverProtocolMessage(ctx, config, agent, team, 'captain', encodeMessage('ORACLE', body), exec);

      return {
        task_id: args.task_id, oracle_sha: sha, red_exit: run.exit,
        // The mapping the team is judged by, printed where the freeze is
        // reported so nobody has to reconstruct it from the four call sites.
        exit_semantics: exitSemantics(record),
        summary: oracleSummary(record), delivered: driver.delivered, freeze_number: forks,
        freeze_kind: record.forkKind, interpretation_forks_left: record.budgetRemaining, artifact_metrics: metrics,
        interpretation_freezes: record.interpretationForks,
        non_gating: record.nonGating,
        reach, ...(reachWarning(record) === undefined ? {} : { warning: reachWarning(record) }),
      };
    },
  }));
}
