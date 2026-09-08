/**
 * Flow tools: the Pair Cycle primitives — pair_propose / pair_review /
 * pair_report / pair_verify — plus the task claim/update that carries the
 * attempt capability and the hard gate on completion.
 *
 * @module dsh-pair-programming/tools/flow
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { withLock } from '../state/lock.js';
import { stateRootFor, workspaceOf, requireAgent, requireParticipantTeam, deliverProtocolMessage } from './shared.js';
import { teamLockKey } from '../state/layout.js';
import {
  readTeam, writeTeam, transitionError, beginTaskAttempt, activateTaskAttempt,
  latestGatePass, unsatisfiedDependencies,
} from '../state/store.js';
import { encodeMessage, feedbackProblems } from '../protocol/messages.js';
import { openCycle, cycleStepError, cycleBudgetForTask, granularitySignal, cycleBudgetExhausted, specFrozen, advancePhase } from '../protocol/machine.js';
import { computeVerdict, resolveCycleOracle } from '../protocol/oracle.js';
import { commandShapeError } from '../protocol/command-shape.js';
import { blocksImplementation, blocksVerification } from '../protocol/risks.js';
import { backPressure } from '../protocol/obligation.js';
import { digestOracleFiles, runOracleCommand, workspaceFingerprint } from './oracle-exec.js';
import { appendPairEvent, captainSessionOf } from '../events.js';
import { planningCoverageError } from '../protocol/coverage.js';
import { gateStateFingerprint, reviewStateFingerprint } from '../protocol/gate.js';
import { captureEvidenceBoundary, assertEvidenceBoundary, checkCancellation, requireLiveEvidenceTarget, requireProductRun } from './verification-boundary.js';
import { taskWorkspace } from '../runtime/workspace-context.js';
import { claimEligibility, prepareTaskWorkspace, requireTaskOwner, proposalScopeError, driverForTask, requireIntegratedHead } from '../runtime/parallel-tasks.js';

const NAVIGATOR = 'navigator';
const DRIVER = 'driver';

/**
 * R4 small-step threshold. A proposal at or under it opens straight at GO.
 *
 * The GO round fired zero NO_GO across five measured instances whose patches
 * were all single-file — it cost two member wakes per cycle and discriminated
 * nothing. It is kept for genuinely large steps (where "split this" is real
 * feedback) and skipped below the same size the I2 small-steps rule already
 * names. The Navigator loses no authority: REJECT still lands at verification,
 * which retains independent counterevidence alongside a computed re-run.
 */
const SMALL_STEP_FILES = 1;
const SMALL_STEP_LINES = 80;

export function isSmallStep(files, netLines) {
  const count = Array.isArray(files) ? files.length : 0;
  const lines = Number.isFinite(netLines) ? Number(netLines) : undefined;
  return count <= SMALL_STEP_FILES && (lines === undefined || lines <= SMALL_STEP_LINES);
}

function requireRole(team, agent, role, action) {
  const member = team.members.find(m => m.id === agent.id && m.status !== 'removed');
  // In solo mode there is no Driver or Navigator seat: the caller builds, and
  // acceptance still requires an independently sealed oracle re-run. The
  // builder may report a counterexample but cannot assert itself into ACCEPT.
  if (team.mode === 'solo') {
    if (member?.role === 'spec') {
      throw new Error(`the SPEC seat may not ${action} — it authors the acceptance oracle and never sees the implementation`);
    }
    return member ?? { name: 'captain', role: 'captain' };
  }
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
function cycleWorkspacePayload(team, cycleId, agent) {
  if (!team.parallel) return {};
  const taskId = requireCycle(team, cycleId).taskId;
  return { task_id: taskId, workspace: taskWorkspace(team, taskId, workspaceOf(agent)) };
}

function requireVerificationStep(team, cycle, stage) {
  if (!cycle) throw new Error('unknown cycle');
  const latest = team.protocol.cycles.filter(c => c.taskId === cycle.taskId).at(-1);
  if (cycle.verify?.verdict === 'accept' || cycle.step === 'CLOSED') throw new Error('cycle is already completed; its final verdict is immutable');
  if (cycle.verify?.verdict === 'checkpoint' && cycle.step === 'VERIFIED' && stage === 'final') {
    if (latest?.id !== cycle.id) throw new Error('VERIFICATION_STALE: only the latest task checkpoint may promote to final acceptance');
    return;
  }
  const problem = cycleStepError(cycle, 'VERIFIED');
  if (problem !== undefined) throw new Error(`${problem}; record a fresh GREEN/report before verification after a REJECT`);
  if (cycle.oracleSha !== undefined && (!cycle.green || !cycle.report)) throw new Error('pair_verify requires a fresh GREEN and report');
}

function requireEvidence(evidence, action) {
  if (!Array.isArray(evidence) || evidence.length === 0 || evidence.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${action} needs independently gathered nonblank evidence`);
  }
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
        // In solo mode the builder is the caller, not a spawned seat — but the
        // attempt token still matters: it is what makes a stale write from an
        // abandoned attempt fail loudly instead of landing.
        const soloBuilder = fresh.mode === 'solo' && fresh.captainSessionId === agent.id;
        const member = soloBuilder
          ? { name: 'captain', role: 'captain' }
          : fresh.members.find(m => m.id === agent.id && m.status !== 'removed');
        if (member === undefined) throw new Error('you are not an active member of this team');
        const task = fresh.tasks.find(t => t.id === args.task_id);
        if (task === undefined) throw new Error(`unknown task "${args.task_id}"`);
        const eligibility = claimEligibility(fresh, member, task);
        if (eligibility) throw new Error(eligibility);
        const owned = fresh.tasks.find(t => t.assignee === member.name && (t.status === 'claimed' || t.status === 'in_progress'));
        if (owned?.id === task.id && typeof task.attemptId === 'string' && task.attemptId !== '') {
          return { task_id: task.id, attempt_id: task.attemptId, attempt: task.attempt ?? 1 };
        }
        if (owned !== undefined) {
          throw new Error('you already own an unfinished task');
        }
        if (task.assignee !== undefined && task.assignee !== member.name) throw new Error(`task "${args.task_id}" is assigned to ${task.assignee}`);
        if (!soloBuilder && member.role !== 'driver' && task.assignee !== member.name) throw new Error('only the Driver may claim unassigned implementation work');
        if (task.status !== 'pending') throw new Error(`task "${args.task_id}" is ${task.status}, not pending`);
        const unsatisfied = unsatisfiedDependencies(fresh.tasks, task.dependencies);
        if (unsatisfied.length > 0) throw new Error(`task "${args.task_id}" is blocked by: ${unsatisfied.join(', ')}`);
        await prepareTaskWorkspace(fresh, member, task, config);
        const attemptId = beginTaskAttempt(task, member.name);
        if (!soloBuilder) member.status = 'working';
        await writeTeam(stateRoot, fresh);
        return { task_id: task.id, attempt_id: attemptId, attempt: task.attempt ?? 1, ...(fresh.parallel ? { workspace: task.workspace, base_head: task.baseHead } : {}) };
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
        requireTaskOwner(fresh, task, agent);
        const workspace = taskWorkspace(fresh, task.id, workspaceOf(agent));
        if (task.attemptId !== undefined && task.attemptId !== args.attempt_id) {
          throw new Error('stale attempt_id — the task was reassigned; stop touching it');
        }
        const terr = transitionError(task.status, args.status);
        if (terr !== undefined) throw new Error(terr);
        if (args.status === 'completed') {
          const pass = latestGatePass(fresh, task.id);
          if (pass === undefined || pass.id !== args.gate_pass_id || task.gatePassId !== args.gate_pass_id) {
            throw new Error('GATE_FAIL: task cannot complete without a valid pair_gate_check pass — run pair_gate_check and supply its gate_pass_id');
          }
          if (fresh.parallel) {
            const candidate = fresh.parallel.integrations?.[task.id]?.candidate;
            if (!candidate || candidate.attemptId !== task.attemptId || candidate.worktreeSha !== pass.binding?.worktreeSha || candidate.gatePassId !== pass.id) throw new Error('INTEGRATION_REQUIRED: the current gated candidate must be integrated before completion');
            await requireIntegratedHead(fresh, task.id);
          }
          if (typeof pass.binding?.worktreeSha !== 'string' || typeof pass.binding?.gateStateSha !== 'string') {
            throw new Error('GATE_STALE: this gate pass predates worktree/board binding — run pair_gate_check again');
          }
          const attempt = pass.binding.taskAttempt;
          if (attempt?.assignee !== (task.assignee ?? null) || attempt?.attemptId !== (task.attemptId ?? null) || attempt?.handoffId !== (task.handoffId ?? null)) {
            throw new Error('GATE_STALE: this gate pass belongs to a different task attempt (or predates attempt binding) — obtain a final review and gate pass for the current attempt');
          }
          if (gateStateFingerprint(fresh, task.id) !== pass.binding.gateStateSha) {
            throw new Error('GATE_STALE: the task card, cycle record, risk register, or task ruling changed after pair_gate_check — re-run the gate against the current board');
          }
          if (task.type === 'spike' && args.output !== undefined && args.output !== task.output) {
            throw new Error('GATE_STALE: a spike outcome cannot change after the gate checked it — update the in-progress task output first, then re-run pair_gate_check');
          }
          if (task.oracle !== undefined) {
            const currentOracleSha = await digestOracleFiles(workspace, task.oracle.files);
            if (currentOracleSha !== task.oracle.sha || currentOracleSha !== pass.binding.oracleSha) {
              throw new Error('GATE_STALE: the frozen oracle changed after pair_gate_check — restore it and re-run the gate');
            }
          }
          const currentWorktreeSha = await workspaceFingerprint(workspace, { stateDir: config.stateDir });
          if (currentWorktreeSha !== pass.binding.worktreeSha) {
            throw new Error('GATE_STALE: the worktree changed after pair_gate_check — re-run the gate against the final tree');
          }
          task.gatePassId = pass.id;
        }
        if (args.status === 'cancelled' && specFrozen(fresh.protocol, task.id)) {
          throw new Error(`task "${task.id}" already has cycles — cancelling work that started needs a recorded reason: pair_arbitrate the decision first, then retry with the same attempt_id (marking the task failed stays available for a real outcome)`);
        }
        task.status = args.status;
        if (fresh.protocol.phase === 'TASK_GATE') advancePhase(fresh.protocol, 'CYCLING');
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
    description: 'Driver only: open a Pair Cycle by proposing one small change before implementing it (invariant I3). A small step (one file, <=80 net lines) opens straight at GO and goes to pair_green; a larger one waits for the Navigator GO verdict so a split is still possible. When the task carries a frozen oracle (pair_oracle), that oracle IS the RED of this cycle — do not write your own acceptance test, and never edit the oracle files: verification recomputes their digest.',
    parameters: {
      task_id: { type: 'string', required: true },
      intent: { type: 'string', required: true, description: 'What this cycle will change and why.' },
      files: { type: 'array', items: { type: 'string' }, required: true, description: 'Files this cycle will touch.' },
      verify_plan: { type: 'string', required: true, description: 'ONE runnable command line that verifies this change, e.g. "npm test" or "node tests/run.mjs". It is EXECUTED verbatim by pair_verify(stage="checkpoint"), so it must be a command, not a description of one — a prose plan here becomes a non-zero exit and a false REJECT against your code. Reasoning belongs in intent.' },
      net_lines: { type: 'number', description: 'Estimated net changed lines; with a single file, <=80 opens the cycle straight at GO (R4).' },
      why_not_split: { type: 'string', description: 'Required when this is NOT a small step (more than one file, or more than 80 net lines): the ONE concern this cycle still is, and why splitting it would produce pieces that cannot be verified independently. I2 is a rule about independent verifiability, not about line count.' },
      no_oracle_reason: { type: 'string', description: 'Only when the task has no frozen oracle and is not trivial: why this cycle can be judged without one (e.g. a spike whose deliverable is a go/no-go decision). It is recorded on the cycle and surfaced in status and the retro — an unrecorded exemption is a bypass.' },
      acceptance_criteria_ref: { type: 'string', description: 'Which acceptance criteria of the task story this cycle serves (e.g. "AC-2" or the criterion text).' },
      uncertainty: { type: 'string', description: 'Honest statement of what you are unsure about.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Cycle ${v.cycle_id} proposed to the Navigator (${v.delivered}).` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      // Fail where the mistake is. Until now a prose verify_plan was only
      // detected two steps later, inside checkpoint verification, where it
      // arrived as a REJECT verdict about the Driver's code rather than as an
      // error about the declaration.
      const planError = commandShapeError(args.verify_plan);
      if (planError !== undefined) throw new Error(planError);
      const stateRoot = stateRootFor(agent, config);
      const team = await requireParticipantTeam(agent, config);
      requireRole(team, agent, DRIVER, 'propose a cycle');
      const tddMode = team.tddMode ?? config.tddMode;
      // Only a PRODUCT P0 halts implementation. An instrument P0 means we
      // cannot yet trust a verdict; it is not a reason to stop producing one.
      const halting = blocksImplementation(team.protocol);
      if (halting.length > 0) {
        throw new Error(`open product P0 risk(s) block new cycles: ${halting.map(r => r.id).join(', ')} — resolve, WONTFIX, or (if the defect is in the acceptance instrument rather than the product) re-file with scope="instrument", which blocks verification instead of implementation.`);
      }
      let cycleId;
      let autoGo = false;
      let cycleWhyNotSplit;
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        const task = fresh.tasks.find(t => t.id === args.task_id);
        if (task === undefined) throw new Error(`unknown task "${args.task_id}"`);
        const scopeError = planningCoverageError(fresh);
        const owner = requireTaskOwner(fresh, task, agent);
        const proposalError = proposalScopeError(fresh, task, args.files);
        if (proposalError) throw new Error(proposalError);
        if (scopeError !== undefined) throw new Error(scopeError);
        // Back-pressure: one unverified cycle per task. Measured failure — a
        // Driver opened 28 cycles and greened 35 times while zero verdicts
        // existed, because v3 gated completion but never continuation.
        const stacked = backPressure(fresh.protocol, args.task_id);
        if (stacked !== undefined) throw new Error(stacked);
        const budget = cycleBudgetForTask(task, config);
        if (cycleBudgetExhausted(fresh.protocol.cycles, args.task_id, budget)) {
          throw new Error(`task "${args.task_id}" exhausted its ${budget}-cycle budget${task?.type === 'spike' ? ' (spikes are a small fixed timebox)' : ''} — the captain must consult the user`);
        }
        // N1: oracle-first. Implementing before the acceptance standard is
        // frozen is exactly how a team ends up verifying its own reading.
        const oracle = task?.oracle;
        // A spike used to be silently exempt, and in a replayed session all
        // three tasks were spikes — so the gate never fired at all, and the
        // team froze oracles only because the captain happened to ask. An
        // exemption nobody records is a bypass. Trivial work (typo/config) is
        // still exempt outright; everything else must either carry an oracle
        // or state, on the board, why it does not.
        const bypass = String(args.no_oracle_reason ?? '').trim();
        if (config.oracleFirst !== false && oracle === undefined && task?.trivial !== true && bypass === '') {
          throw new Error(`task "${args.task_id}" has no frozen oracle — ask the Navigator to run pair_oracle first (SPEC-FORK). It derives the acceptance test from the request alone, before your approach exists; that independence is the only thing review adds that you do not already have.${task?.type === 'spike' ? ' A spike is not automatically exempt: if its deliverable really is a decision rather than code, say so in no_oracle_reason and it is recorded on the board.' : ''} Genuinely trivial work can be marked trivial=true to skip it.`);
        }
        autoGo = isSmallStep(args.files, args.net_lines);
        // I2 above the auto-GO threshold used to be prose only: net_lines
        // decided whether the GO round was skipped and nothing else, so an
        // oversized proposal was merely one that waited. A measured cycle went
        // through as three files, ~300 lines and two plainly separate concerns
        // (weather and life) — and was GO'd, in a session whose review seat
        // issued zero NO_GO. The tool still cannot judge "one concern", so it
        // does not pretend to: it makes the claim explicit, which is what gives
        // the reviewer something concrete to refuse.
        if (!autoGo) {
          const why = String(args.why_not_split ?? '').trim();
          if (why === '') {
            throw new Error(`this cycle is above the small-step threshold (${(args.files ?? []).length} file(s), ~${args.net_lines ?? '?'} net lines), so I2 asks you to state why_not_split: name the ONE concern this still is, and why the pieces could not be verified independently. If you cannot name it in a sentence, that is the answer — split it.`);
          }
          cycleWhyNotSplit = why;
        }
        const cycle = openCycle(fresh.protocol, args.task_id, {
          tddMode, trivial: task?.trivial === true, oracleSha: oracle?.sha,
        });
        if (owner) cycle.owner = { memberId: owner.id, assignee: owner.name, attemptId: task.attemptId };
        cycle.proposal = {
          intent: args.intent, files: args.files, verify_plan: args.verify_plan,
          acceptance_criteria_ref: args.acceptance_criteria_ref ?? '',
          net_lines: args.net_lines, uncertainty: args.uncertainty ?? '',
          ...(cycleWhyNotSplit === undefined ? {} : { whyNotSplit: cycleWhyNotSplit }), at: Date.now(),
        };
        if (oracle === undefined && bypass !== '') cycle.noOracleReason = bypass;
        if (oracle !== undefined) {
          // The frozen oracle IS the RED: it was proven failing before any
          // implementation existed, by an author who had not seen one.
          cycle.red = {
            test_files: oracle.files,
            evidence: [
              `frozen oracle @${String(oracle.sha).slice(0, 12)} — cmd "${oracle.cmd}" exit ${String(oracle.redExit)} on the untouched tree`,
              `chosen reading: ${oracle.chosen}`,
            ],
            fromOracle: true,
            at: oracle.frozenAt ?? Date.now(),
          };
        }
        if (autoGo) {
          cycle.step = 'GO';
          cycle.review = {
            verdict: 'go', auto: true,
            evidence: [`small step (${(args.files ?? []).length} file(s)${args.net_lines === undefined ? '' : `, ~${args.net_lines} net lines`}) under the R4 threshold — GO round skipped, REJECT authority stays with the Navigator at verification`],
            at: Date.now(),
          };
        }
        cycleId = cycle.id;
        advancePhase(fresh.protocol, 'CYCLING');
        await writeTeam(stateRoot, fresh);
      });
      const sent = await deliverProtocolMessage(ctx, config, agent, team, NAVIGATOR,
        encodeMessage('PROPOSE', {
          cycle_id: cycleId, task_id: args.task_id, intent: args.intent, files: args.files,
          ...(team.parallel ? { workspace: taskWorkspace(team, args.task_id, workspaceOf(agent)) } : {}),
          verify_plan: args.verify_plan,
          ...(args.acceptance_criteria_ref !== undefined ? { acceptance_criteria_ref: args.acceptance_criteria_ref } : {}),
          ...(autoGo ? { auto_go: true } : {}),
          uncertainty: args.uncertainty ?? '',
        }), exec);
      return { cycle_id: cycleId, delivered: sent.delivered, you_owe_next: sent.you_owe_next, auto_go: autoGo, step: autoGo ? 'GO' : 'PROPOSED' };
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
      if (!['go', 'no_go'].includes(args.verdict)) throw new Error('pair_review verdict must be go or no_go');
      requireEvidence(args.evidence, 'proposal review');
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
        checkCancellation(exec.signal);
        requireLiveEvidenceTarget(fresh, cycle.taskId, agent);
        requireRole(fresh, agent, NAVIGATOR, 'review a cycle');
        if (cycle.step === 'VERIFIED' || cycle.step === 'CLOSED' || ['accept', 'checkpoint'].includes(cycle.verify?.verdict)) throw new Error('cycle is already completed; proposal review cannot rewind it');
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
      const sent = await deliverProtocolMessage(ctx, config, agent, team, driverForTask(team, requireCycle(team, args.cycle_id).taskId),
        encodeMessage(args.verdict === 'go' ? 'GO' : 'NO_GO', {
          cycle_id: args.cycle_id, evidence: args.evidence,
          ...(args.conditions !== undefined ? { conditions: args.conditions } : {}),
          ...(feedback !== undefined ? { feedback, required_changes: feedback.way_forward } : {}),
        }), exec);
      return { cycle_id: args.cycle_id, verdict: args.verdict, delivered: sent.delivered, you_owe_next: sent.you_owe_next };
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
        if (cycle.oracleSha !== undefined) {
          throw new Error('this cycle is judged by a frozen oracle, which IS its RED — you must not author the acceptance test you are measured against. Go straight to pair_green; if you believe the oracle is wrong, say so and let the Navigator re-fork it.');
        }
        requireTaskOwner(fresh, fresh.tasks.find(task => task.id === cycle.taskId), agent, cycle);
        const serr = cycleStepError(cycle, 'RED');
        if (serr !== undefined) throw new Error(serr);
        cycle.red = { test_files: args.test_files, evidence: args.red_evidence, at: Date.now() };
        cycle.step = 'RED';
        await writeTeam(stateRoot, fresh);
      });
      const sent = await deliverProtocolMessage(ctx, config, agent, team, NAVIGATOR,
        encodeMessage('RED', {
          cycle_id: args.cycle_id, test_files: args.test_files, red_evidence: args.red_evidence,
          ...cycleWorkspacePayload(team, args.cycle_id, agent),
        }), exec);
      return { cycle_id: args.cycle_id, delivered: sent.delivered, you_owe_next: sent.you_owe_next };
    },
  }));

  /* pair_green ---------------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_green',
    description: 'Driver only (after GO): apply the MINIMAL production change that turns the failing test green, then report it. No extra features, no speculative design (YAGNI). On an oracle cycle this is the last Driver step — pass diff_summary and test_results here; there is no separate refactor round (clean up under the green net inside this same step).',
    parameters: {
      cycle_id: { type: 'string', required: true },
      green_evidence: { type: 'array', items: { type: 'string' }, required: true, description: 'Passing run output snippets (the previously failing test now green).' },
      diff_summary: { type: 'string', description: 'Files + net lines + key hunks (required on an oracle cycle; the full diff stays on disk).' },
      test_results: { type: 'string', description: 'Verification command(s) run and their outcome (required on an oracle cycle).' },
      deviations: { type: 'string', description: 'How the result differs from the approved proposal.' },
      tuned_for_oracle: { type: 'string', required: true, description: 'Which values, thresholds, sizes, positions or parameters in this change you chose so the ORACLE would pass, rather than because the request asked for them — and what the request would have wanted instead. Write "none" if every choice came from the request. This is not a confession; it is the one thing a re-run cannot see.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Cycle ${v.cycle_id}: GREEN recorded.` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const stateRoot = stateRootFor(agent, config);
      const team = await requireParticipantTeam(agent, config);
      requireRole(team, agent, DRIVER, 'record GREEN');
      if (!(args.green_evidence?.length > 0)) throw new Error('GREEN needs the passing-run evidence');
      // The blind spot a computed verdict cannot cover. pair_verify re-runs the
      // sealed command, so it passes by construction; beyond_request asks what
      // was done BEYOND the request, and tuning to the instrument is the
      // opposite shape — the product made smaller, dimmer or differently
      // placed so a threshold clears. Measured, twice in one session: a rain
      // effect dropped from opacity 0.4 to 0.18 "so the idle patches stay
      // under the diff threshold", and a rain volume shrunk from +/-6 to
      // +/-4.85 because a footprint assertion failed, then justified after the
      // fact as "the correct look for a collectible miniature". Nothing on the
      // board could see either one. Now they land here, on the cycle, and in
      // the retro.
      const tuned = String(args.tuned_for_oracle ?? '').trim();
      if (tuned === '') {
        throw new Error('GREEN needs tuned_for_oracle: name the values you picked to satisfy the ORACLE rather than the request (sizes, opacities, thresholds, positions, counts), or write "none". A re-run proves the command passes; it is structurally blind to a product bent to fit its own measuring instrument, so this is the only place that fact can be recorded.');
      }
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        const cycle = requireCycle(fresh, args.cycle_id);
        const serr = cycleStepError(cycle, 'GREEN');
        requireTaskOwner(fresh, fresh.tasks.find(task => task.id === cycle.taskId), agent, cycle);
        if (serr !== undefined) throw new Error(serr);
        if (cycle.oracleSha !== undefined && String(args.diff_summary ?? '').trim() === '') {
          throw new Error('an oracle cycle folds REFACTOR into GREEN (R5) — this is the reporting step, so pass diff_summary (and test_results) here');
        }
        cycle.green = { evidence: args.green_evidence, tunedForOracle: tuned, at: Date.now() };
        // R5: GREEN carries the cycle report on an oracle cycle; there is no
        // separate REFACTOR round to collect it later.
        if (args.diff_summary !== undefined || args.test_results !== undefined) {
          cycle.report = {
            diff_summary: args.diff_summary ?? '', test_results: args.test_results ?? '',
            deviations: args.deviations ?? '', foldedIntoGreen: true, at: Date.now(),
          };
        }
        cycle.step = 'GREEN';
        await writeTeam(stateRoot, fresh);
      });
      const sent = await deliverProtocolMessage(ctx, config, agent, team, NAVIGATOR,
        encodeMessage('GREEN', {
          cycle_id: args.cycle_id, green_evidence: args.green_evidence,
          ...cycleWorkspacePayload(team, args.cycle_id, agent),
          tuned_for_oracle: tuned,
          ...(args.diff_summary !== undefined ? { diff_summary: args.diff_summary } : {}),
          ...(args.test_results !== undefined ? { test_results: args.test_results } : {}),
          ...(args.deviations !== undefined ? { deviations: args.deviations } : {}),
        }), exec);
      return { cycle_id: args.cycle_id, delivered: sent.delivered, you_owe_next: sent.you_owe_next };
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
        if (cycle.oracleSha !== undefined) {
          throw new Error('an oracle cycle folds REFACTOR into GREEN (R5) — there is no separate refactor round. Clean up under the green oracle inside pair_green and report it there.');
        }
        requireTaskOwner(fresh, fresh.tasks.find(task => task.id === cycle.taskId), agent, cycle);
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
      const sent = await deliverProtocolMessage(ctx, config, agent, team, NAVIGATOR,
        encodeMessage('REFACTOR', {
          cycle_id: args.cycle_id, diff_summary: args.diff_summary,
          ...cycleWorkspacePayload(team, args.cycle_id, agent),
          test_results: args.test_results,
          ...(args.refactor_evidence !== undefined ? { refactor_evidence: args.refactor_evidence } : {}),
          deviations: args.deviations ?? '',
        }), exec);
      return { cycle_id: args.cycle_id, delivered: sent.delivered, you_owe_next: sent.you_owe_next };
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
        if (cycle.oracleSha !== undefined) {
          throw new Error('an oracle cycle reports through pair_green (which carries diff_summary and test_results); the verdict is then computed by re-running the frozen oracle, not from this report.');
        }
        requireTaskOwner(fresh, fresh.tasks.find(task => task.id === cycle.taskId), agent, cycle);
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
      const sent = await deliverProtocolMessage(ctx, config, agent, team, NAVIGATOR,
        encodeMessage('REPORT', {
          cycle_id: args.cycle_id, diff_summary: args.diff_summary,
          ...cycleWorkspacePayload(team, args.cycle_id, agent),
          test_results: args.test_results, deviations: args.deviations ?? '',
        }), exec);
      return { cycle_id: args.cycle_id, delivered: sent.delivered, you_owe_next: sent.you_owe_next };
    },
  }));

  /* pair_verify --------------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_verify',
    description: 'Navigator only: verify an unfinished cycle after GREEN/report. The frozen oracle is re-run, but a structured independent REJECT with evidence overrides a green result. stage="final" (default) requires the full oracle and scope reading for ACCEPT. stage="checkpoint" runs the predeclared verify_plan and releases the next cycle without final acceptance. The latest checkpoint may promote to final; a final ACCEPT is immutable. Changed board/candidate or infrastructure failure refuses the call without a product verdict. Legacy cycles remain independently asserted with evidence.',
    parameters: {
      cycle_id: { type: 'string', required: true },
      stage: { type: 'string', description: 'final (default) | checkpoint. Checkpoint is valid only on an oracle cycle and executes that cycle\'s predeclared proposal.verify_plan.' },
      verdict: { type: 'string', description: 'accept | reject — required on a legacy cycle. On oracle cycles, reject is an independent veto requiring evidence and all three feedback fields; accept cannot override a failing oracle.' },
      evidence: { type: 'array', items: { type: 'string' }, description: 'Evidence gathered independently; required for a reviewer REJECT and legacy verdicts. Preserved alongside computed test evidence.' },
      observation: { type: 'string', description: 'REJECT part 1: objective fact of what you saw.' },
      impact: { type: 'string', description: 'REJECT part 2: the concrete effect if unchanged.' },
      way_forward: { type: 'string', description: 'REJECT part 3: the actionable change required. Vague wishes are rejected.' },
      reason_category: { type: 'string', description: 'REJECT classification for the retro: invest_violation | test_first_violation | risk_hit | quality | other (default other).' },
      beyond_request: { type: 'string', description: 'REQUIRED to ACCEPT an oracle cycle. Read the diff and name what it changes that the request did NOT ask for — extra generality, new cases handled, refactors taken along the way. Write "nothing" only after looking. A computed verdict proves the requested behaviour is right; it is blind to behaviour nobody requested.' },
      preexisting_at_risk: { type: 'string', description: 'REQUIRED to ACCEPT an oracle cycle. Name the existing behaviour this diff could alter, and how you checked. Measured failure: a comma-handling fix also rewrote an existing list/tuple contract and broke it — the frozen oracle passed and the full regression suite passed 18/18, because neither was looking there.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Cycle ${v.cycle_id}: ${v.verdict.toUpperCase()}.` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const stateRoot = stateRootFor(agent, config);
      const team = await requireParticipantTeam(agent, config);
      requireRole(team, agent, NAVIGATOR, 'verify a cycle');
      checkCancellation(exec.signal);
      if (args.verdict !== undefined && !['accept', 'reject'].includes(args.verdict)) throw new Error('verdict must be "accept" or "reject"');
      let feedback;
      if (args.verdict === 'reject') {
        feedback = { observation: args.observation, impact: args.impact, way_forward: args.way_forward };
        const problems = feedbackProblems(feedback);
        if (problems.length > 0) throw new Error(`a REJECT must be structured constructive feedback (observation -> impact -> way_forward):\n- ${problems.join('\n- ')}`);
        requireEvidence(args.evidence, 'a reviewer REJECT');
      }
      // Any open P0 — product or instrument — makes a verdict meaningless.
      const untrusted = blocksVerification(team.protocol);
      if (untrusted.length > 0) {
        throw new Error(`open P0 risk(s) make any verdict untrustworthy: ${untrusted.map(r => `${r.id}(${r.scope ?? 'product'})`).join(', ')} — an ACCEPT recorded now would assert something nobody can stand behind. Resolve or WONTFIX first; implementation may continue meanwhile if the P0 is instrument-scoped.`);
      }

      // Solo mode relaxes WHO may record a verdict, never WHAT makes one valid.
      // A cycle with no frozen oracle is decided by assertion, and an agent
      // asserting that its own code is correct is exactly the correlated
      // judgement this plugin exists to prevent.
      if (team.mode === 'solo') {
        const soloCycle = team.protocol.cycles.find(c => c.id === args.cycle_id);
        if (soloCycle !== undefined && soloCycle.oracleSha === undefined) {
          throw new Error('in solo mode a cycle can only be closed by a computed verdict: freeze an oracle for this task with pair_oracle and open the cycle against it. Accepting your own implementation on your own say-so is the correlated judgement the protocol exists to prevent — there is no second seat here to catch it.');
        }
      }

      // A green re-execution is necessary for acceptance, never a veto waiver.
      const target = team.protocol.cycles.find(c => c.id === args.cycle_id);
      const sealed = resolveCycleOracle(target, team.tasks.find(t => t.id === target?.taskId));
      if (sealed.error !== undefined) throw new Error(sealed.error);
      const oracle = sealed.oracle;
      const stage = args.stage ?? 'final';
      if (stage !== 'final' && stage !== 'checkpoint') throw new Error('pair_verify stage must be "final" or "checkpoint"');
      if (stage === 'checkpoint' && oracle === undefined) {
        throw new Error('stage="checkpoint" requires a frozen oracle: it is an intermediate machine check under a final sealed contract, not an asserted legacy verdict');
      }
      requireVerificationStep(team, target, stage);
      if (oracle === undefined) {
        if (!['accept', 'reject'].includes(args.verdict)) throw new Error('verdict must be "accept" or "reject" on a cycle without a frozen oracle');
        requireEvidence(args.evidence, 'legacy verification');
      }
      const boundary = await captureEvidenceBoundary(team, target.taskId, agent, config, exec.signal);
      let computed;
      let run;
      let actualSha;
      if (oracle !== undefined) {
        const workspace = taskWorkspace(team, target.taskId, workspaceOf(agent));
        actualSha = await digestOracleFiles(workspace, oracle.files);
        const tampered = actualSha !== oracle.sha;
        if (tampered) {
          computed = computeVerdict({ tampered: true });
        } else if (stage === 'checkpoint') {
          const command = String(target?.proposal?.verify_plan ?? '').trim();
          // Re-checked here as well as at pair_propose, because a cycle
          // proposed by an older build carries an unvalidated plan. A verdict
          // must never be manufactured out of a declaration defect: running
          // prose exits non-zero and used to be recorded as REJECT /
          // checkpoint_red — charging stats.reject and this cycle's rejection
          // budget for a failure that never happened, rewinding it out of its
          // GO, and telling the Driver their code is broken. Refuse the CALL
          // instead; the cycle keeps its step and its budget.
          const shape = commandShapeError(command, { field: 'this cycle\'s proposal.verify_plan' });
          if (shape !== undefined) {
            throw new Error(`checkpoint verification cannot run, and will not invent a verdict from a malformed declaration: ${shape} Re-propose this cycle with a runnable command, or use stage="final" to judge it against the frozen oracle instead.`);
          }
          run = await runOracleCommand(workspace, command, { signal: exec.signal });
          requireProductRun(run, exec.signal);
          computed = run.exit === 0
            ? { verdict: 'checkpoint', category: 'checkpoint_green', reason: 'the cycle\'s predeclared verify_plan passes; the full oracle remains reserved for the final ACCEPT' }
            : { verdict: 'reject', category: 'checkpoint_red', reason: `the cycle\'s predeclared verify_plan still fails (exit ${String(run.exit)})` };
        } else {
          const shape = commandShapeError(oracle.cmd, { field: 'oracle_cmd' });
          if (shape !== undefined) throw new Error(shape);
          run = await runOracleCommand(workspace, oracle.cmd, { signal: exec.signal });
          requireProductRun(run, exec.signal);
          computed = computeVerdict({ run });
        }
      }
      await assertEvidenceBoundary(boundary, await readTeam(stateRoot, team.id), agent, config, exec.signal);
      const testOutcome = computed;
      if (computed !== undefined && args.verdict === 'reject') computed = { verdict: 'reject', category: 'reviewer_reject', reason: 'independent reviewer evidence vetoes this candidate; the computed test outcome is retained separately' };
      const verdict = computed?.verdict ?? args.verdict;
      if (computed === undefined && verdict !== 'accept' && verdict !== 'reject') {
        throw new Error('verdict must be "accept" or "reject" on a cycle without a frozen oracle');
      }
      // An ACCEPT on a computed cycle must still be signed by someone who read
      // the diff. v3 made the verdict a re-run precisely so it could not be
      // asserted — but a re-run only asks whether the REQUESTED behaviour is
      // right. The failure it cannot see is a change that does more than was
      // asked and breaks something nobody was testing. That gap is not closed
      // by another oracle arm; it is closed by a person naming what they saw.
      if (computed?.verdict === 'accept') {
        const beyond = String(args.beyond_request ?? '').trim();
        const atRisk = String(args.preexisting_at_risk ?? '').trim();
        if (beyond === '' || atRisk === '') {
          throw new Error('the oracle passes, but an ACCEPT also needs a scope reading: set beyond_request (what this diff changes that the request did not ask for — "nothing" is a valid answer once you have looked) and preexisting_at_risk (what existing behaviour it could alter, and how you checked). A green re-run proves the requested behaviour; it is blind to the behaviour nobody requested, which is where the measured regression lived.');
        }
      }
      const evidence = computed === undefined
        ? (args.evidence ?? [])
        : [
          `computed verdict: ${computed.reason}`,
          `frozen oracle digest ${String(oracle.sha).slice(0, 12)} vs current ${String(actualSha).slice(0, 12)}`,
          ...(run === undefined ? [] : [`cmd "${run.command}" exit ${String(run.exit)}`, `output tail: ${run.outputTail}`]),
          ...(args.evidence ?? []),
        ];
      let taskId;
      let granularity;
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        const cycle = requireCycle(fresh, args.cycle_id);
        await assertEvidenceBoundary(boundary, fresh, agent, config, exec.signal);
        requireRole(fresh, agent, NAVIGATOR, 'verify a cycle');
        requireVerificationStep(fresh, cycle, stage);
        if (computed !== undefined && cycle.review?.verdict !== 'go' && cycle.review?.auto !== true) {
          throw new Error('pair_verify on this cycle needs a recorded GO review first');
        }
        cycle.verify = {
          verdict, stage, evidence, feedback,
          binding: { worktreeSha: boundary.worktreeSha, assignee: fresh.tasks.find(t => t.id === cycle.taskId)?.assignee ?? null, attemptId: fresh.tasks.find(t => t.id === cycle.taskId)?.attemptId ?? null, handoffId: fresh.tasks.find(t => t.id === cycle.taskId)?.handoffId ?? null },
          ...(String(args.beyond_request ?? '').trim() !== '' ? { beyondRequest: String(args.beyond_request).trim() } : {}),
          ...(String(args.preexisting_at_risk ?? '').trim() !== '' ? { preexistingAtRisk: String(args.preexisting_at_risk).trim() } : {}),
          ...(computed === undefined ? {} : { computed: true, category: computed.category, testOutcome, oracleSha: actualSha, ...(run === undefined ? {} : { exit: run.exit }) }),
          at: Date.now(),
        };
        if (verdict === 'accept' || verdict === 'checkpoint') cycle.step = 'VERIFIED';
        else {
          // A rejected cycle rewinds to its last granted permission. An
          // auto-GO cycle (R4) never had a GO round to repeat, so it rewinds
          // to GO and the Driver simply fixes the mechanism and re-runs GREEN;
          // rewinding it to PROPOSED would strand it with no way back.
          cycle.step = cycle.review?.auto === true ? 'GO' : 'PROPOSED';
          cycle.rejections = (cycle.rejections ?? 0) + 1;
          fresh.protocol.stats.reject += 1;
          const cat = computed?.category
            ?? (['invest_violation', 'test_first_violation', 'risk_hit', 'quality', 'other'].includes(args.reason_category) ? args.reason_category : 'other');
          fresh.protocol.stats.reasons = { ...(fresh.protocol.stats.reasons ?? {}), [cat]: ((fresh.protocol.stats.reasons ?? {})[cat] ?? 0) + 1 };
        }
        taskId = cycle.taskId;
        cycle.verify.binding.gateStateSha = reviewStateFingerprint(fresh, taskId);
        granularity = granularitySignal(fresh.protocol.cycles);
        await writeTeam(stateRoot, fresh);
      });
      const sent = await deliverProtocolMessage(ctx, config, agent, team, driverForTask(team, taskId),
        encodeMessage(verdict === 'accept' ? 'ACCEPT' : verdict === 'checkpoint' ? 'INFO' : 'REJECT', {
          cycle_id: args.cycle_id, evidence,
          stage,
          ...(computed !== undefined ? { computed: true, category: computed.category, reason: computed.reason } : {}),
          ...(feedback !== undefined ? { feedback } : {}),
        }), exec);
      // Surface the granularity signal to the captain after the cycle resolves.
      const signal = granularity;
      if (signal.signal !== 'steady') {
        await deliverProtocolMessage(ctx, config, agent, team, 'captain',
          encodeMessage('INFO', { granularity: signal.signal, reason: signal.reason, task_id: taskId }), exec);
      }
      return {
        cycle_id: args.cycle_id, verdict, stage, delivered: sent.delivered, you_owe_next: sent.you_owe_next,
        // 2026-02 repair: on the tampered path run is undefined, so exit was
        // serialized as undefined and the host binding rejected the WHOLE tool
        // result ("binding arguments must be lossless JSON") AFTER withLock had
        // already committed — the caller saw an error while the state moved.
        // Omit the field instead of serializing a hole.
        ...(computed === undefined ? {} : {
          computed: true, category: computed.category, reason: computed.reason,
          ...(run?.exit === undefined ? {} : { exit: run.exit }),
        }),
      };
    },
  }));
}
