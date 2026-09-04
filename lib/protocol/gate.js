/**
 * The quality gate: the checklist executor that must pass before any task may
 * be marked completed. This is the hard enforcement point — pair_task_update
 * refuses status=completed without a valid gate pass from here.
 *
 * Pure logic over the team record — unit-testable.
 *
 * @module dsh-pair-programming/protocol/gate
 */

import { createHash } from 'node:crypto';
import { openBlockingRisks } from './risks.js';

/**
 * Hash only the board facts one task gate actually judges.
 *
 * The worktree digest catches file changes. This sibling catches board-only
 * changes after a pass: a newly raised blocker, a new cycle, a changed card,
 * or a new task-scoped ruling. Volatile member activity, stats, timestamps and
 * the credential itself are excluded so a harmless scheduler heartbeat does
 * not invalidate a pass.
 */
export function gateStateFingerprint(team, taskId) {
  const task = (team?.tasks ?? []).find(item => item.id === taskId);
  const {
    gatePassId: _gatePassId, updatedAt: _updatedAt, status: _status,
    assignee: _assignee, attemptId: _attemptId, handoffId: _handoffId,
    ...boundTask
  } = task ?? {};
  // Feature output is a completion summary, not a gate input. A spike output
  // is the decision/estimate the gate explicitly checks, so keep that one.
  if (task?.type !== 'spike') delete boundTask.output;
  const protocol = team?.protocol ?? {};
  const payload = {
    task: boundTask,
    cycles: (protocol.cycles ?? []).filter(cycle => cycle.taskId === taskId),
    // P2 is intentionally absent: runGate does not block on it, so raising a
    // style/optimization backlog item must not stale an otherwise valid pass.
    risks: (protocol.risks ?? []).filter(risk => risk.severity === 'P0' || risk.severity === 'P1'),
    decisions: (protocol.decisions ?? []).filter(decision => decision.taskId === taskId),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * The Definition-of-Done check ids. This list is the Scrum DoD ("a common,
 * agreed checklist so everyone means the same thing by finished") made
 * configurable per deployment via config.dod.
 */
export const DEFAULT_DOD = Object.freeze([
  'all_accepted',        // every cycle is settled and at least one has a final ACCEPT
  'no_blocking_risks',   // no OPEN P0/P1 risk tickets
  'verify_evidence',     // the latest ACCEPT is a computed re-run (oracle) or carries evidence (legacy)
  'decisions_documented',// every arbitration in the task has a recorded rationale
  'test_first',          // (tddMode=enforce) accepted cycles show a RED step before GREEN
  'oracle_precedes_impl',// (N1) the acceptance oracle was frozen before the first cycle opened
  'oracle_replay',       // (N4) the gate re-ran the frozen oracle itself and it passed
  'spike_outcome',       // (spike tasks) a decision/estimate outcome is recorded
  'deliverables_present',// the files the task said it would produce actually exist
  'scope_declared',      // the diff touched only files a proposal declared
  'goal_criteria_traced',// every epic criterion on this card maps to an executable oracle case
]);

/**
 * Run the completion gate checklist (the configurable Definition of Done)
 * for one task.
 *
 * @param {object} team - the durable team record.
 * @param {string} taskId - the task being completed.
 * @param {{tddMode?:string, dod?:string[], oracleReplay?:{ok:boolean, reason?:string}}} [opts] -
 *   DoD item selection, the session TDD mode (test_first only bites when
 *   tddMode === 'enforce'), and the gate's own oracle replay result (N4).
 * @returns {{pass:true, checklist:object} | {pass:false, failures:string[], checklist:object}}
 */
export function runGate(team, taskId, opts = {}) {
  const protocol = team.protocol;
  const task = team.tasks.find(t => t.id === taskId);
  const enabled = new Set(opts.dod ?? DEFAULT_DOD);
  const failures = [];
  const checklist = { taskId, dod: [...enabled], at: Date.now() };

  const taskCycles = protocol.cycles.filter(c => c.taskId === taskId);
  const oracle = task?.oracle;

  if (enabled.has('goal_criteria_traced') && (task?.acceptanceRefs ?? []).length > 0) {
    const missing = task.acceptanceRefs.filter(ref => !(oracle?.caseRefs ?? []).includes(ref));
    checklist.goalCriteria = { assigned: task.acceptanceRefs, executable: oracle?.caseRefs ?? [], missing };
    if (missing.length > 0) failures.push(`goal acceptance criteria lack executable oracle cases: ${missing.join(', ')}`);
  }

  // [ ] every cycle is settled; checkpointed slices do not replace a final ACCEPT.
  if (enabled.has('all_accepted')) {
    const unsettled = taskCycles.filter(c => !['accept', 'checkpoint'].includes(c.verify?.verdict));
    const finalAccepts = taskCycles.filter(c => c.verify?.verdict === 'accept');
    checklist.allAccepted = taskCycles.length > 0 && unsettled.length === 0 && finalAccepts.length > 0;
    checklist.checkpointCycles = taskCycles.filter(c => c.verify?.verdict === 'checkpoint').map(c => c.id);
    if (!checklist.allAccepted) {
      failures.push(taskCycles.length === 0
        ? 'task has no pair cycles — nothing was verified'
        : unsettled.length > 0
          ? `${unsettled.length} cycle(s) lack a computed checkpoint/final verdict: ${unsettled.map(c => c.id).join(', ')}`
          : 'task has checkpointed increments but no final oracle ACCEPT — run pair_verify(stage="final") on the last cycle');
    }
  }

  // [ ] no OPEN P0/P1 risk tickets.
  if (enabled.has('no_blocking_risks')) {
    const blocking = openBlockingRisks(protocol, ['P0', 'P1']);
    checklist.openBlockingRisks = blocking.map(r => `${r.id}(${r.severity})`);
    if (blocking.length > 0) {
      failures.push(`unresolved blocking risk(s): ${blocking.map(r => `${r.id}(${r.severity})`).join(', ')}`);
    }
  }

  // [ ] the acceptance was DERIVED, not asserted.
  //
  // v2 accepted `evidence.length > 0` here — a non-empty array of prose, which
  // the Driver's own report already satisfied, which is why a parroted ACCEPT
  // was structurally invisible to this gate. With a frozen oracle the bar is
  // that the ACCEPT is a recorded re-run; without one the legacy honour-system
  // check remains, and says so.
  if (enabled.has('verify_evidence')) {
    const lastAccept = [...taskCycles].reverse().find(c => c.verify?.verdict === 'accept');
    const hasEvidence = lastAccept !== undefined
      && Array.isArray(lastAccept.verify.evidence)
      && lastAccept.verify.evidence.length > 0;
    if (oracle !== undefined) {
      checklist.verifyPassed = lastAccept?.verify?.computed === true;
      if (!checklist.verifyPassed) {
        failures.push('the accepted cycle was not verified by re-running the frozen oracle — an oracle task cannot complete on an asserted verdict (re-run pair_verify)');
      }
    } else {
      checklist.verifyPassed = hasEvidence;
      checklist.verifyEvidenceIsHonourSystem = true;
      if (!checklist.verifyPassed) {
        failures.push('no ACCEPT carries verification evidence (test/build/lint result)');
      }
    }
  }

  // [ ] N1: the oracle predates the work it judges.
  if (enabled.has('oracle_precedes_impl') && oracle !== undefined) {
    const firstOpened = Math.min(...taskCycles.map(c => c.openedAt ?? Number.POSITIVE_INFINITY));
    checklist.oraclePrecedesImpl = taskCycles.length === 0
      || (oracle.frozenAt ?? Number.POSITIVE_INFINITY) <= firstOpened;
    if (!checklist.oraclePrecedesImpl) {
      failures.push('the oracle was frozen AFTER the first cycle opened — an acceptance test written once an approach exists is no longer independent of it');
    }
  }

  // [ ] N4: the gate re-ran the oracle itself rather than trusting the record.
  if (enabled.has('oracle_replay') && oracle !== undefined) {
    checklist.oracleReplay = opts.oracleReplay ?? { ok: false, reason: 'the gate did not replay the oracle' };
    if (checklist.oracleReplay.ok !== true) {
      failures.push(`the gate replay of the frozen oracle did not pass: ${checklist.oracleReplay.reason ?? 'unknown'}`);
    }
  }

  // [ ] every arbitration inside this task has a recorded rationale.
  if (enabled.has('decisions_documented')) {
    const undocumented = protocol.decisions.filter(d => d.taskId === taskId && (d.rationale === undefined || d.rationale === ''));
    checklist.undocumentedDecisions = undocumented.map(d => d.id);
    if (undocumented.length > 0) {
      failures.push(`${undocumented.length} arbitration(s) lack a recorded rationale`);
    }
  }

  // [ ] Test First: under enforce mode, each accepted cycle must carry RED
  // (failing-test) evidence before its GREEN (passing-implementation) step.
  // Trivial-task cycles are exempt (the "don't pair for typos" rule).
  if (enabled.has('test_first') && opts.tddMode === 'enforce') {
    const violated = taskCycles.filter(c =>
      (c.verify?.verdict === 'accept' || c.verify?.verdict === 'checkpoint') && c.trivial !== true
      && (!(c.red?.evidence?.length > 0) || !(c.green?.evidence?.length > 0)
        || (c.red?.at ?? Infinity) > (c.green?.at ?? -Infinity)));
    checklist.testFirstCompliant = violated.length === 0;
    if (violated.length > 0) {
      failures.push(`${violated.length} accepted cycle(s) violate Test First (no RED failing-test evidence before GREEN): ${violated.map(c => c.id).join(', ')} — production code must not exist before a failing test did`);
    }
  }

  // [ ] The task produced what it said it would produce.
  //
  // Measured failure: a task completed with a valid gate_pass_id while the
  // patch.diff and self-report.json its own contract named were never written.
  // Every other DoD item was green, because every other item asks about the
  // PROCESS. Nothing asked whether the artifact exists. An acceptance oracle
  // proves the behaviour is right; it says nothing about whether anyone
  // actually handed over the thing that was ordered.
  if (enabled.has('deliverables_present') && (task?.deliverables ?? []).length > 0) {
    const report = opts.deliverableCheck;
    checklist.deliverables = report ?? { ok: false, reason: 'the gate did not check the declared deliverables' };
    if (checklist.deliverables.ok !== true) {
      failures.push(`declared deliverable(s) missing or empty: ${(checklist.deliverables.missing ?? []).join(', ') || checklist.deliverables.reason}`);
    }
  }

  // [ ] The change stayed inside the scope the team declared.
  //
  // A cycle declares files[] before it is allowed to start. When the diff
  // reaches files nobody proposed, the work grew past the plan without anyone
  // deciding to let it — which is how a fix aimed at one behaviour quietly
  // rewrites another and regresses it. Line-count drift is recorded but never
  // fails on its own: estimating net lines up front is honest guesswork.
  if (enabled.has('scope_declared')) {
    const report = opts.scopeCheck;
    if (report !== undefined) {
      checklist.scope = report;
      if (report.undeclared?.length > 0) {
        failures.push(`the diff touched file(s) no proposal declared: ${report.undeclared.join(', ')} — declare them in a proposal (and let the Navigator see the wider blast radius) or revert them`);
      }
    }
  }

  // [ ] A spike's deliverable is the decision, not code: record the outcome.
  if (enabled.has('spike_outcome') && task?.type === 'spike') {
    checklist.spikeOutcomeRecorded = String(task.output ?? '').trim() !== '';
    if (!checklist.spikeOutcomeRecorded) {
      failures.push('spike task completes without an outcome — record the go/no-go decision or the estimate the research was meant to buy');
    }
  }

  return failures.length === 0
    ? { pass: true, checklist }
    : { pass: false, failures, checklist };
}
