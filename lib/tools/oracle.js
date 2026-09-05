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
import { forkProblems, redProblem, freezeRecord, oracleSummary, reachWarning, nonGatingProblems } from '../protocol/oracle.js';
import { commandShapeError } from '../protocol/command-shape.js';
import { assertTaskOracleFiles, assessOracleReach, digestOracleFiles, resolveTaskOracleFile, runOracleCommand } from './oracle-exec.js';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { appendPairEvent, captainSessionOf } from '../events.js';
import { oracleCoverageProblems } from '../protocol/coverage.js';

export function registerOracleTools(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'pair_oracle_write',
    description: 'Navigator only: write one acceptance-test artifact before freezing it. This is the Navigator\'s only workspace write capability; path must be under .pair-oracles/<task_id>/, never production source.',
    parameters: {
      task_id: { type: 'string', required: true },
      path: { type: 'string', required: true, description: 'Path under .pair-oracles/<task_id>/.' },
      content: { type: 'string', required: true, description: 'UTF-8 test artifact content (maximum 1 MiB).' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Oracle artifact written: ${v.path}` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const workspace = workspaceOf(agent);
      const team = await requireParticipantTeam(agent, config);
      const member = team.members.find(m => m.id === agent.id && m.status !== 'removed');
      const writer = team.mode === 'solo' ? 'spec' : 'navigator';
      if (member?.role !== writer) throw new Error(`only the ${writer === 'spec' ? 'SPEC seat' : 'Navigator'} can write an oracle artifact (you are ${member?.role ?? 'not a member'})`);
      const task = team.tasks.find(t => t.id === args.task_id);
      if (task === undefined) throw new Error(`unknown task "${args.task_id}"`);
      if (team.protocol.cycles.some(c => c.taskId === args.task_id && c.verify?.verdict === 'accept')) {
        throw new Error(`task "${args.task_id}" already has an accepted cycle — its oracle artifacts are immutable`);
      }
      if (Buffer.byteLength(args.content, 'utf8') > 1024 * 1024) throw new Error('oracle artifact exceeds the 1 MiB limit');
      const target = resolveTaskOracleFile(workspace, args.task_id, args.path);
      await mkdir(dirname(target), { recursive: true });
      await atomicWriteText(target, args.content);
      return { task_id: args.task_id, path: args.path, bytes: Buffer.byteLength(args.content, 'utf8') };
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
      oracle_files: { type: 'array', items: { type: 'string' }, required: true, description: 'Acceptance test paths under .pair-oracles/<task_id>/, written through pair_oracle_write.' },
      oracle_cmd: { type: 'string', required: true, description: 'ONE runnable command line that runs the acceptance test, e.g. "node tests/acceptance.mjs". It must FAIL right now, and it is re-executed verbatim at every later verdict — so a prose plan or a mistyped program name seals into the task contract and then "fails" forever for a reason that has nothing to do with the code.' },
      expected_failure: { type: 'string', description: 'The failure signature you expect today, in your own words.' },
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
      const workspace = workspaceOf(agent);
      const team = await requireParticipantTeam(agent, config);
      const member = team.members.find(m => m.id === agent.id && m.status !== 'removed');
      const author = team.mode === 'solo' ? 'spec' : 'navigator';
      if (member?.role !== author) {
        throw new Error(`only the ${author === 'spec' ? 'SPEC seat' : 'Navigator'} freezes the oracle (you are ${member?.role ?? 'not a member'}) — the point is that its author has not seen the implementation, which in solo mode is guaranteed by that seat holding no reader and no shell`);
      }
      const task = team.tasks.find(t => t.id === args.task_id);
      if (task === undefined) throw new Error(`unknown task "${args.task_id}"`);
      if (team.protocol.cycles.some(c => c.taskId === args.task_id && c.verify?.verdict === 'accept')) {
        throw new Error(`task "${args.task_id}" already has an accepted cycle — re-freezing the oracle after acceptance would rewrite the standard the work was judged against`);
      }
      // An in-flight cycle carries a stamp of the seal it was opened against.
      // Re-forking under it would leave the Driver working to one standard and
      // being judged by another, so the cycle must finish or be abandoned first.
      // 2026-02 repair: a cycle that already carries a verdict has "reached a
      // verdict" — the rewind to PROPOSED is bookkeeping, not in-flightness.
      // Without this exclusion a moved-seal REJECT deadlocks re-forking forever
      // (rewind to PROPOSED keeps the fork gate closed; the designed "a REJECT
      // is fine, then re-freeze" path was unreachable — measured live on
      // omen-1-雨夜便利店街角 t-2, two zombie cycles, captain state surgery needed).
      const inFlight = team.protocol.cycles.find(c => c.taskId === args.task_id && c.step !== 'VERIFIED' && c.step !== 'CLOSED' && c.verify === undefined);
      if (inFlight !== undefined && team.tasks.find(t => t.id === args.task_id)?.oracle !== undefined) {
        throw new Error(`cycle ${inFlight.id} is in flight at step ${inFlight.step} against the current oracle — re-forking now would judge the Driver by a standard it was never shown. Let the cycle reach a verdict first (a REJECT is fine), then re-freeze.`);
      }
      // Freeze budget with an escape hatch. Measured failure: a single oracle
      // was re-forked six-plus times over 2h 16min, each fork valid, the set
      // divergent. A soft cap surfaces the pattern; captain_override names the
      // escape so wrong lists still stop but real progress does not.
      const budget = config.oracleForkBudget ?? 3;
      const defectFix = args.fork_kind === 'defect';
      if (args.fork_kind !== undefined && args.fork_kind !== 'interpretation' && args.fork_kind !== 'defect') {
        throw new Error('fork_kind must be interpretation or defect');
      }
      if (defectFix && String(args.defect_evidence ?? '').trim() === '') {
        throw new Error('defect_evidence is required for a defect correction; otherwise it is an interpretation re-fork and spends the normal budget');
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

      assertTaskOracleFiles(args.task_id, args.oracle_files);

      // Digest first, then run: the seal must describe the bytes that produced
      // the RED, not whatever the command may have rewritten on its way.
      const sha = await digestOracleFiles(workspace, args.oracle_files);
      const run = await runOracleCommand(workspace, args.oracle_cmd);
      const notRed = redProblem(run);
      if (notRed !== undefined) {
        throw new Error(`${notRed}\n\ncommand: ${run.command}\nexit: ${String(run.exit)}\noutput tail:\n${run.outputTail}`);
      }

      const reach = await assessOracleReach(workspace, args.oracle_files);
      const forks = (task.oracle?.forks ?? 0) + 1;
      const record = freezeRecord(args, { sha, run, by: member.name, reach, forks });
      record.interpretationForks = (task.oracle?.interpretationForks ?? task.oracle?.forks ?? 0) + (defectFix ? 0 : 1);
      if (defectFix) record.defectEvidence = String(args.defect_evidence).trim();
      if (String(args.captain_override ?? '').trim() !== '') record.captainOverride = String(args.captain_override).trim();
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        const target = fresh.tasks.find(t => t.id === args.task_id);
        if (target === undefined) throw new Error(`unknown task "${args.task_id}"`);
        target.oracle = record;
        target.updatedAt = Date.now();
        await writeTeam(stateRoot, fresh);
      });

      appendPairEvent(ctx, captainSessionOf(ctx, team.captainSessionId, agent.session), 'pair/oracle-frozen', {
        teamId: team.id, taskId: args.task_id, sha, cmd: record.cmd, readings: record.readings.length,
      });

      const body = {
        task_id: args.task_id, oracle_sha: sha, oracle_cmd: record.cmd,
        oracle_files: record.files, chosen_reading: record.chosen,
        divergence_candidates: record.divergences,
        case_refs: record.caseRefs,
        red_exit: run.exit, red_tail: run.outputTail,
        ...(reachWarning(record) === undefined ? {} : { reach_warning: reachWarning(record) }),
        note: 'This oracle is frozen. Do not edit its files: verification recomputes the digest and a changed oracle is an automatic REJECT.',
      };
      const driver = await deliverProtocolMessage(ctx, config, agent, team, 'driver', encodeMessage('ORACLE', body), exec);
      await deliverProtocolMessage(ctx, config, agent, team, 'captain', encodeMessage('ORACLE', body), exec);

      return {
        task_id: args.task_id, oracle_sha: sha, red_exit: run.exit,
        summary: oracleSummary(record), delivered: driver.delivered, freeze_number: forks,
        interpretation_freezes: record.interpretationForks,
        non_gating: record.nonGating,
        reach, ...(reachWarning(record) === undefined ? {} : { warning: reachWarning(record) }),
      };
    },
  }));
}
