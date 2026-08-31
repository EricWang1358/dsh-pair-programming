/**
 * Flow tools: the Pair Cycle primitives — pair_propose / pair_review /
 * pair_report / pair_verify — plus the task claim/update that carries the
 * attempt capability and the hard gate on completion.
 *
 * @module dsh-pair-programming/tools/flow
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { withLock } from '../state/lock.js';
import { stateRootFor, requireAgent, requireParticipantTeam, deliverProtocolMessage } from './shared.js';
import { teamLockKey } from '../state/layout.js';
import {
  readTeam, writeTeam, transitionError, beginTaskAttempt, activateTaskAttempt,
  latestGatePass, unsatisfiedDependencies,
} from '../state/store.js';
import { encodeMessage, feedbackProblems } from '../protocol/messages.js';
import { openCycle, cycleStepError, cycleBudgetForTask, granularitySignal, cycleBudgetExhausted } from '../protocol/machine.js';
import { appendPairEvent, captainSessionOf } from '../events.js';

const NAVIGATOR = 'navigator';
const DRIVER = 'driver';

function requireRole(team, agent, role, action) {
  const member = team.members.find(m => m.id === agent.id && m.status !== 'removed');
  if (member?.role !== role) {
    throw new Error(`only the ${role} can ${action} (you are ${member?.role ?? 'not a member'})`);
  }
  return member;
}

function requireCycle(team, cycleId) {
  const cycle = team.protocol.cycles.find(c => c.id === cycleId);
  if (cycle === undefined) throw new Error(`unknown cycle "${cycleId}"`);
  return cycle;
}

export function registerFlowTools(ctx, config, runtime) {
  const { scheduler } = runtime;

  /* pair_task_claim ----------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_task_claim',
    description: 'Claim one ready task for yourself (a member). Returns the attempt_id capability you must include in every pair_task_update for this attempt. A member owns at most one unfinished task.',
    parameters: { task_id: { type: 'string', required: true, description: 'The task id to claim.' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Task ${v.task_id} claimed (attempt ${v.attempt_id}).` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const stateRoot = stateRootFor(agent, config);
      const team = await requireParticipantTeam(agent, config);
      return withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        const member = fresh.members.find(m => m.id === agent.id && m.status !== 'removed');
        if (member === undefined) throw new Error('you are not an active member of this team');
        if (fresh.tasks.some(t => t.assignee === member.name && (t.status === 'claimed' || t.status === 'in_progress'))) {
          throw new Error('you already own an unfinished task');
        }
        const task = fresh.tasks.find(t => t.id === args.task_id);
        if (task === undefined) throw new Error(`unknown task "${args.task_id}"`);
        if (task.status !== 'pending') throw new Error(`task "${args.task_id}" is ${task.status}, not pending`);
        const unsatisfied = unsatisfiedDependencies(fresh.tasks, task.dependencies);
        if (unsatisfied.length > 0) throw new Error(`task "${args.task_id}" is blocked by: ${unsatisfied.join(', ')}`);
        const attemptId = beginTaskAttempt(task, member.name);
        member.status = 'working';
        await writeTeam(stateRoot, fresh);
        return { task_id: task.id, attempt_id: attemptId, attempt: task.attempt ?? 1 };
      });
    },
  }));

  /* pair_task_update ---------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_task_update',
    description: 'Update a task status/output. Requires the current attempt_id. status=completed is REJECTED without a valid gate_pass_id from pair_gate_check (hard quality gate). Terminal results are immutable.',
    parameters: {
      task_id: { type: 'string', required: true },
      status: { type: 'string', required: true, description: 'in_progress | completed | failed | cancelled' },
      output: { type: 'string', description: 'Result summary; set when completing or failing.' },
      attempt_id: { type: 'string', required: true, description: 'Current execution capability from pair_task_claim.' },
      gate_pass_id: { type: 'string', description: 'Required when status=completed: the pass id from pair_gate_check.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Task ${v.task_id} → ${v.status}.` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const stateRoot = stateRootFor(agent, config);
      const team = await requireParticipantTeam(agent, config);
      return withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        const task = fresh.tasks.find(t => t.id === args.task_id);
        if (task === undefined) throw new Error(`unknown task "${args.task_id}"`);
        if (task.attemptId !== undefined && task.attemptId !== args.attempt_id) {
          throw new Error('stale attempt_id — the task was reassigned; stop touching it');
        }
        const terr = transitionError(task.status, args.status);
        if (terr !== undefined) throw new Error(terr);
        if (args.status === 'completed') {
          const pass = latestGatePass(fresh, task.id);
          if (pass === undefined || pass.id !== args.gate_pass_id) {
            throw new Error('GATE_FAIL: task cannot complete without a valid pair_gate_check pass — run pair_gate_check and supply its gate_pass_id');
          }
        }
        task.status = args.status;
        if (args.output !== undefined) task.output = args.output;
        task.updatedAt = Date.now();
        const member = fresh.members.find(m => m.name === task.assignee);
        if (member !== undefined && (args.status === 'completed' || args.status === 'failed' || args.status === 'cancelled')) {
          member.status = 'idle';
          task.attemptId = undefined;
        }
        await writeTeam(stateRoot, fresh);
        appendPairEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, agent.session), 'pair/task-updated', {
          teamId: fresh.id, taskId: task.id, status: task.status, assignee: task.assignee,
        });
        return { task_id: task.id, status: task.status };
      });
    },
  }));

  /* pair_propose -------------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_propose',
    description: 'Driver only: open a Pair Cycle by proposing one small change before implementing it (invariant I3). Delivers the proposal to the Navigator and waits for GO. Under TDD mode the GO is followed by pair_red -> pair_green -> pair_refactor; the acceptance criteria of the story should be referenced.',
    parameters: {
      task_id: { type: 'string', required: true },
      intent: { type: 'string', required: true, description: 'What this cycle will change and why.' },
      files: { type: 'array', items: { type: 'string' }, required: true, description: 'Files this cycle will touch.' },
      verify_plan: { type: 'string', required: true, description: 'How the change will be verified (test/build/lint command).' },
      acceptance_criteria_ref: { type: 'string', description: 'Which acceptance criteria of the task story this cycle serves (e.g. "AC-2" or the criterion text).' },
      uncertainty: { type: 'string', description: 'Honest statement of what you are unsure about.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Cycle ${v.cycle_id} proposed to the Navigator (${v.delivered}).` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const stateRoot = stateRootFor(agent, config);
      const team = await requireParticipantTeam(agent, config);
      requireRole(team, agent, DRIVER, 'propose a cycle');
      const tddMode = team.tddMode ?? config.tddMode;
      if (team.protocol.risks.some(r => r.status === 'OPEN' && r.severity === 'P0')) {
        throw new Error('an open P0 risk blocks new cycles — resolve it first');
      }
      let cycleId;
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        const task = fresh.tasks.find(t => t.id === args.task_id);
        const budget = cycleBudgetForTask(task, config);
        if (cycleBudgetExhausted(fresh.protocol.cycles, args.task_id, budget)) {
          throw new Error(`task "${args.task_id}" exhausted its ${budget}-cycle budget${task?.type === 'spike' ? ' (spikes are a small fixed timebox)' : ''} — the captain must consult the user`);
        }
        const cycle = openCycle(fresh.protocol, args.task_id, { tddMode, trivial: task?.trivial === true });
        cycle.proposal = {
          intent: args.intent, files: args.files, verify_plan: args.verify_plan,
          acceptance_criteria_ref: args.acceptance_criteria_ref ?? '',
          uncertainty: args.uncertainty ?? '', at: Date.now(),
        };
        cycleId = cycle.id;
        await writeTeam(stateRoot, fresh);
      });
      const { delivered } = await deliverProtocolMessage(ctx, config, agent, team, NAVIGATOR,
        encodeMessage('PROPOSE', {
          cycle_id: cycleId, task_id: args.task_id, intent: args.intent, files: args.files,
          verify_plan: args.verify_plan,
          ...(args.acceptance_criteria_ref !== undefined ? { acceptance_criteria_ref: args.acceptance_criteria_ref } : {}),
          uncertainty: args.uncertainty ?? '',
        }), exec);
      return { cycle_id: cycleId, delivered };
    },
  }));

  /* pair_review --------------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_review',
    description: 'Navigator only: verdict on a proposal — GO (with evidence and optional conditions) or NO_GO. A NO_GO must be structured constructive feedback: observation (objective fact), impact (concrete effect), way_forward (actionable change). Evidence is mandatory on any verdict (invariant I6).',
    parameters: {
      cycle_id: { type: 'string', required: true },
      verdict: { type: 'string', required: true, description: 'go | no_go' },
      evidence: { type: 'array', items: { type: 'string' }, required: true, description: 'Repository evidence backing the verdict.' },
      conditions: { type: 'string', description: 'Conditions attached to a GO.' },
      observation: { type: 'string', description: 'NO_GO part 1: objective fact of what you saw (file/line/behavior).' },
      impact: { type: 'string', description: 'NO_GO part 2: the concrete effect on the product/team if unchanged.' },
      way_forward: { type: 'string', description: 'NO_GO part 3: the actionable change required. Vague wishes are rejected.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Cycle ${v.cycle_id}: ${v.verdict.toUpperCase()}.` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const stateRoot = stateRootFor(agent, config);
      const team = await requireParticipantTeam(agent, config);
      requireRole(team, agent, NAVIGATOR, 'review a cycle');
      let feedback;
      if (args.verdict === 'no_go') {
        feedback = { observation: args.observation, impact: args.impact, way_forward: args.way_forward };
        const problems = feedbackProblems(feedback);
        if (problems.length > 0) {
          throw new Error(`a NO_GO must be structured constructive feedback (observation -> impact -> way_forward):\n- ${problems.join('\n- ')}`);
        }
      }
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        const cycle = requireCycle(fresh, args.cycle_id);
        const serr = cycleStepError(cycle, args.verdict === 'go' ? 'GO' : 'PROPOSED');
        if (args.verdict === 'go' && serr !== undefined) throw new Error(serr);
        cycle.review = {
          verdict: args.verdict, evidence: args.evidence,
          conditions: args.conditions, feedback,
          required_changes: feedback?.way_forward, at: Date.now(),
        };
        if (args.verdict === 'go') cycle.step = 'GO';
        else { cycle.step = 'PROPOSED'; cycle.rejections = (cycle.rejections ?? 0) + 1; fresh.protocol.stats.noGo += 1; }
        await writeTeam(stateRoot, fresh);
      });
      const { delivered } = await deliverProtocolMessage(ctx, config, agent, team, DRIVER,
        encodeMessage(args.verdict === 'go' ? 'GO' : 'NO_GO', {
          cycle_id: args.cycle_id, evidence: args.evidence,
          ...(args.conditions !== undefined ? { conditions: args.conditions } : {}),
          ...(feedback !== undefined ? { feedback, required_changes: feedback.way_forward } : {}),
        }), exec);
      return { cycle_id: args.cycle_id, verdict: args.verdict, delivered };
    },
  }));

  /* pair_red ------------------------------------------------------------ */
  ctx.tools.register(defineTool({
    name: 'pair_red',
    description: 'Driver only (TDD enforce mode, after GO): land the failing test FIRST and record its red evidence — the actual failing run output (a compile error of the missing API counts as RED). No production code yet (invariant I7).',
    parameters: {
      cycle_id: { type: 'string', required: true },
      test_files: { type: 'array', items: { type: 'string' }, required: true, description: 'Test files added/changed for this RED step.' },
      red_evidence: { type: 'array', items: { type: 'string' }, required: true, description: 'Failing run output snippets proving the test fails for the right reason.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Cycle ${v.cycle_id}: RED recorded.` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const stateRoot = stateRootFor(agent, config);
      const team = await requireParticipantTeam(agent, config);
      requireRole(team, agent, DRIVER, 'record RED');
      if (!(args.red_evidence?.length > 0)) throw new Error('RED needs the failing-run evidence');
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        const cycle = requireCycle(fresh, args.cycle_id);
        const serr = cycleStepError(cycle, 'RED');
        if (serr !== undefined) throw new Error(serr);
        cycle.red = { test_files: args.test_files, evidence: args.red_evidence, at: Date.now() };
        cycle.step = 'RED';
        await writeTeam(stateRoot, fresh);
      });
      const { delivered } = await deliverProtocolMessage(ctx, config, agent, team, NAVIGATOR,
        encodeMessage('RED', {
          cycle_id: args.cycle_id, test_files: args.test_files, red_evidence: args.red_evidence,
        }), exec);
      return { cycle_id: args.cycle_id, delivered };
    },
  }));

  /* pair_green ---------------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_green',
    description: 'Driver only (TDD enforce mode, after RED): apply the MINIMAL production change that turns the failing test green and record the passing run as green evidence. No extra features, no speculative design (YAGNI).',
    parameters: {
      cycle_id: { type: 'string', required: true },
      green_evidence: { type: 'array', items: { type: 'string' }, required: true, description: 'Passing run output snippets (the previously failing test now green).' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Cycle ${v.cycle_id}: GREEN recorded.` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const stateRoot = stateRootFor(agent, config);
      const team = await requireParticipantTeam(agent, config);
      requireRole(team, agent, DRIVER, 'record GREEN');
      if (!(args.green_evidence?.length > 0)) throw new Error('GREEN needs the passing-run evidence');
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        const cycle = requireCycle(fresh, args.cycle_id);
        const serr = cycleStepError(cycle, 'GREEN');
        if (serr !== undefined) throw new Error(serr);
        cycle.green = { evidence: args.green_evidence, at: Date.now() };
        cycle.step = 'GREEN';
        await writeTeam(stateRoot, fresh);
      });
      const { delivered } = await deliverProtocolMessage(ctx, config, agent, team, NAVIGATOR,
        encodeMessage('GREEN', { cycle_id: args.cycle_id, green_evidence: args.green_evidence }), exec);
      return { cycle_id: args.cycle_id, delivered };
    },
  }));

  /* pair_refactor ------------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_refactor',
    description: 'Driver only (TDD enforce mode, after GREEN): clean up duplication/naming under the green safety net, re-run the tests, and report diff_summary + test_results. This is the cycle report the Navigator verifies.',
    parameters: {
      cycle_id: { type: 'string', required: true },
      diff_summary: { type: 'string', required: true, description: 'Files + net lines + key hunks (full diff stays on disk).' },
      test_results: { type: 'string', required: true, description: 'Test suite outcome after the refactor (must still be green).' },
      refactor_evidence: { type: 'array', items: { type: 'string' }, description: 'What was cleaned up and the re-run output proving green.' },
      deviations: { type: 'string', description: 'How the result differs from the approved proposal.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Cycle ${v.cycle_id}: REFACTOR reported to the Navigator.` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const stateRoot = stateRootFor(agent, config);
      const team = await requireParticipantTeam(agent, config);
      requireRole(team, agent, DRIVER, 'report REFACTOR');
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        const cycle = requireCycle(fresh, args.cycle_id);
        const serr = cycleStepError(cycle, 'REFACTOR');
        if (serr !== undefined) throw new Error(serr);
        cycle.report = {
          diff_summary: args.diff_summary, test_results: args.test_results,
          refactor_evidence: args.refactor_evidence ?? [],
          deviations: args.deviations ?? '', at: Date.now(),
        };
        cycle.step = 'REFACTOR';
        await writeTeam(stateRoot, fresh);
      });
      const { delivered } = await deliverProtocolMessage(ctx, config, agent, team, NAVIGATOR,
        encodeMessage('REFACTOR', {
          cycle_id: args.cycle_id, diff_summary: args.diff_summary,
          test_results: args.test_results,
          ...(args.refactor_evidence !== undefined ? { refactor_evidence: args.refactor_evidence } : {}),
          deviations: args.deviations ?? '',
        }), exec);
      return { cycle_id: args.cycle_id, delivered };
    },
  }));

  /* pair_report --------------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_report',
    description: 'Driver only: after implementing, report the diff summary, test results, and any deviation from the proposal. Delivers to the Navigator for independent verification.',
    parameters: {
      cycle_id: { type: 'string', required: true },
      diff_summary: { type: 'string', required: true, description: 'Files + net lines + key hunks (full diff stays on disk).' },
      test_results: { type: 'string', required: true, description: 'Verification command(s) run and their outcome.' },
      deviations: { type: 'string', description: 'How the result differs from the approved proposal.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Cycle ${v.cycle_id} reported to the Navigator.` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const stateRoot = stateRootFor(agent, config);
      const team = await requireParticipantTeam(agent, config);
      requireRole(team, agent, DRIVER, 'report a cycle');
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        const cycle = requireCycle(fresh, args.cycle_id);
        if (cycle.tddMode === 'enforce' && !cycle.trivial) {
          throw new Error('TDD enforce mode: report the cycle with pair_red -> pair_green -> pair_refactor instead (Test First, invariant I7)');
        }
        const serr = cycleStepError(cycle, 'IMPLEMENTED');
        if (serr !== undefined) throw new Error(serr);
        cycle.report = {
          diff_summary: args.diff_summary, test_results: args.test_results,
          deviations: args.deviations ?? '', at: Date.now(),
        };
        cycle.step = 'IMPLEMENTED';
        await writeTeam(stateRoot, fresh);
      });
      const { delivered } = await deliverProtocolMessage(ctx, config, agent, team, NAVIGATOR,
        encodeMessage('REPORT', {
          cycle_id: args.cycle_id, diff_summary: args.diff_summary,
          test_results: args.test_results, deviations: args.deviations ?? '',
        }), exec);
      return { cycle_id: args.cycle_id, delivered };
    },
  }));

  /* pair_verify --------------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_verify',
    description: 'Navigator only: independently verify a reported cycle (run the tests / read the code yourself — under TDD, confirm the RED evidence predates any production code), then ACCEPT or REJECT with evidence you gathered — never parrot the Driver\'s report. A REJECT must be structured constructive feedback (observation -> impact -> way_forward) with a reason category for the retrospective.',
    parameters: {
      cycle_id: { type: 'string', required: true },
      verdict: { type: 'string', required: true, description: 'accept | reject' },
      evidence: { type: 'array', items: { type: 'string' }, required: true, description: 'Evidence you gathered independently.' },
      observation: { type: 'string', description: 'REJECT part 1: objective fact of what you saw.' },
      impact: { type: 'string', description: 'REJECT part 2: the concrete effect if unchanged.' },
      way_forward: { type: 'string', description: 'REJECT part 3: the actionable change required. Vague wishes are rejected.' },
      reason_category: { type: 'string', description: 'REJECT classification for the retro: invest_violation | test_first_violation | risk_hit | quality | other (default other).' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Cycle ${v.cycle_id}: ${v.verdict.toUpperCase()}.` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const stateRoot = stateRootFor(agent, config);
      const team = await requireParticipantTeam(agent, config);
      requireRole(team, agent, NAVIGATOR, 'verify a cycle');
      let feedback;
      if (args.verdict === 'reject') {
        feedback = { observation: args.observation, impact: args.impact, way_forward: args.way_forward };
        const problems = feedbackProblems(feedback);
        if (problems.length > 0) {
          throw new Error(`a REJECT must be structured constructive feedback (observation -> impact -> way_forward):\n- ${problems.join('\n- ')}`);
        }
      }
      let taskId;
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        const cycle = requireCycle(fresh, args.cycle_id);
        const serr = cycleStepError(cycle, 'VERIFIED');
        if (serr !== undefined) throw new Error(serr);
        cycle.verify = { verdict: args.verdict, evidence: args.evidence, feedback, at: Date.now() };
        if (args.verdict === 'accept') cycle.step = 'VERIFIED';
        else {
          cycle.step = 'PROPOSED';
          cycle.rejections = (cycle.rejections ?? 0) + 1;
          fresh.protocol.stats.reject += 1;
          const cat = ['invest_violation', 'test_first_violation', 'risk_hit', 'quality', 'other'].includes(args.reason_category) ? args.reason_category : 'other';
          fresh.protocol.stats.reasons = { ...(fresh.protocol.stats.reasons ?? {}), [cat]: ((fresh.protocol.stats.reasons ?? {})[cat] ?? 0) + 1 };
        }
        taskId = cycle.taskId;
        await writeTeam(stateRoot, fresh);
      });
      const { delivered } = await deliverProtocolMessage(ctx, config, agent, team, DRIVER,
        encodeMessage(args.verdict === 'accept' ? 'ACCEPT' : 'REJECT', {
          cycle_id: args.cycle_id, evidence: args.evidence,
          ...(feedback !== undefined ? { feedback } : {}),
        }), exec);
      // Surface the granularity signal to the captain after the cycle resolves.
      const signal = granularitySignal(team.protocol.cycles);
      if (signal.signal !== 'steady') {
        await deliverProtocolMessage(ctx, config, agent, team, 'captain',
          encodeMessage('INFO', { granularity: signal.signal, reason: signal.reason, task_id: taskId }), exec);
      }
      return { cycle_id: args.cycle_id, verdict: args.verdict, delivered };
    },
  }));
}
