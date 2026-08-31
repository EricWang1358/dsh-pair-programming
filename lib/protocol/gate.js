/**
 * The quality gate: the checklist executor that must pass before any task may
 * be marked completed. This is the hard enforcement point — pair_task_update
 * refuses status=completed without a valid gate pass from here.
 *
 * Pure logic over the team record — unit-testable.
 *
 * @module dsh-pair-programming/protocol/gate
 */

import { openBlockingRisks } from './risks.js';

/**
 * The Definition-of-Done check ids. This list is the Scrum DoD ("a common,
 * agreed checklist so everyone means the same thing by finished") made
 * configurable per deployment via config.dod.
 */
export const DEFAULT_DOD = Object.freeze([
  'all_accepted',        // every cycle of the task has a Navigator ACCEPT
  'no_blocking_risks',   // no OPEN P0/P1 risk tickets
  'verify_evidence',     // the latest ACCEPT carries independent verification evidence
  'decisions_documented',// every arbitration in the task has a recorded rationale
  'test_first',          // (tddMode=enforce) accepted cycles show a RED step before GREEN
  'spike_outcome',       // (spike tasks) a decision/estimate outcome is recorded
]);

/**
 * Run the completion gate checklist (the configurable Definition of Done)
 * for one task.
 *
 * @param {object} team - the durable team record.
 * @param {string} taskId - the task being completed.
 * @param {{tddMode?:string, dod?:string[]}} [opts] - DoD item selection and
 *   the session TDD mode (test_first only bites when tddMode === 'enforce').
 * @returns {{pass:true, checklist:object} | {pass:false, failures:string[], checklist:object}}
 */
export function runGate(team, taskId, opts = {}) {
  const protocol = team.protocol;
  const task = team.tasks.find(t => t.id === taskId);
  const enabled = new Set(opts.dod ?? DEFAULT_DOD);
  const failures = [];
  const checklist = { taskId, dod: [...enabled], at: Date.now() };

  const taskCycles = protocol.cycles.filter(c => c.taskId === taskId);

  // [ ] every cycle has an ACCEPT verdict.
  if (enabled.has('all_accepted')) {
    const unaccepted = taskCycles.filter(c => c.verify?.verdict !== 'accept');
    checklist.allAccepted = taskCycles.length > 0 && unaccepted.length === 0;
    if (!checklist.allAccepted) {
      failures.push(taskCycles.length === 0
        ? 'task has no pair cycles — nothing was verified'
        : `${unaccepted.length} cycle(s) lack a Navigator ACCEPT: ${unaccepted.map(c => c.id).join(', ')}`);
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

  // [ ] the latest verification command passed (from the most recent ACCEPT evidence).
  if (enabled.has('verify_evidence')) {
    const lastAccept = [...taskCycles].reverse().find(c => c.verify?.verdict === 'accept');
    checklist.verifyPassed = lastAccept !== undefined
      && Array.isArray(lastAccept.verify.evidence)
      && lastAccept.verify.evidence.length > 0;
    if (!checklist.verifyPassed) {
      failures.push('no ACCEPT carries verification evidence (test/build/lint result)');
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
      c.verify?.verdict === 'accept' && c.trivial !== true
      && (!(c.red?.evidence?.length > 0) || !(c.green?.evidence?.length > 0)
        || (c.red?.at ?? Infinity) > (c.green?.at ?? -Infinity)));
    checklist.testFirstCompliant = violated.length === 0;
    if (violated.length > 0) {
      failures.push(`${violated.length} accepted cycle(s) violate Test First (no RED failing-test evidence before GREEN): ${violated.map(c => c.id).join(', ')} — production code must not exist before a failing test did`);
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
