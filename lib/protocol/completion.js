/** Terminal success/abort semantics and the durable completion receipt. */
import { createHash } from 'node:crypto';
import { goalCoverage } from './coverage.js';
import { openBlockingRisks } from './risks.js';
import { openDisclosures, residualLedger } from './disclosure.js';
import { gateStateFingerprint } from './gate.js';

/** Explain every condition that still prevents a successful team completion. */
export function completionReadiness(team, { greenRequired = true, greenEvidence = '', worktreeSha, ceLoads } = {}) {
  const failures = [];
  const tasks = team?.tasks ?? [];
  if (tasks.length === 0) failures.push('the board has no task cards');
  const notCompleted = tasks.filter(task => task.status !== 'completed');
  if (notCompleted.length > 0) failures.push(`task(s) are not completed: ${notCompleted.map(task => `${task.id}[${task.status}]`).join(', ')}`);
  const passes = team?.protocol?.gatePasses ?? [];
  const latestFor = task => passes.filter(pass => pass.taskId === task.id).at(-1);
  const withoutPass = tasks.filter(task => task.status === 'completed'
    && latestFor(task)?.id !== task.gatePassId);
  if (withoutPass.length > 0) failures.push(`completed task(s) lack their exact gate credential: ${withoutPass.map(task => task.id).join(', ')}`);
  const staleBoard = tasks.filter(task => {
    const pass = latestFor(task);
    return task.status === 'completed' && pass?.id === task.gatePassId
      && (typeof pass.binding?.gateStateSha !== 'string' || pass.binding.gateStateSha !== gateStateFingerprint(team, task.id));
  });
  if (staleBoard.length > 0) failures.push(`completed task(s) have a gate credential stale against the current board: ${staleBoard.map(task => task.id).join(', ')} — re-run pair_gate_check`);
  if (typeof worktreeSha === 'string') {
    const staleTree = tasks.filter(task => {
      const pass = latestFor(task);
      return task.status === 'completed' && pass?.id === task.gatePassId && pass.binding?.worktreeSha !== worktreeSha;
    });
    if (staleTree.length > 0) failures.push(`completed task(s) have a gate credential stale against the final worktree: ${staleTree.map(task => task.id).join(', ')} — re-run pair_gate_check`);
  }
  const blocking = openBlockingRisks(team?.protocol ?? {}, ['P0', 'P1']);
  if (blocking.length > 0) failures.push(`blocking risk(s) remain: ${blocking.map(risk => `${risk.id}(${risk.severity}/${risk.status})`).join(', ')}`);
  const coverage = goalCoverage(team);
  if (coverage.total === 0) failures.push('the epic has no enumerated use cases');
  if (coverage.missingAllocation.length > 0) failures.push(`unallocated goal criteria: ${coverage.missingAllocation.join(', ')}`);
  if (coverage.missingOracle.length > 0) failures.push(`goal criteria lack executable oracle cases: ${coverage.missingOracle.join(', ')}`);
  if (coverage.incomplete.length > 0) failures.push(`goal criteria are not completed: ${coverage.incomplete.join(', ')}`);
  // Disclosure is not treatment. Every one of these was written down honestly
  // at the moment it happened and then owned by nobody: a measured session
  // shipped rain as white squares, puddles with no reflections and a plinth
  // stripped of its outline, each disclosed, each routed to a "visual final
  // check" with no tool and no checklist behind it, while the board read 9/9.
  // Shipping with a known gap stays allowed; doing it without anyone deciding
  // to does not.
  const disclosures = openDisclosures(team);
  if (disclosures.length > 0) {
    failures.push(`declared blind spot(s) nobody has ruled on: ${disclosures.map(item => `${item.ref} (${item.kind})`).join(', ')} — fix each gap and record that ruling with pair_arbitrate(closes_disclosure="<ref>"), or explicitly accept the residual gap`);
  }
  // A receipt binds a success claim to a worktree. If a second execution loop
  // was driving that worktree during the run, the binding describes a state
  // nobody owned — and an unreadable ledger cannot show that it did not.
  if (ceLoads !== undefined) {
    if (ceLoads.readable === false) {
      failures.push('the Compound Engineering load ledger could not be read, so this run cannot show that no second execution loop drove the worktree');
    } else if (ceLoads.violation?.ok === false) {
      failures.push(ceLoads.violation.reason);
    }
  }
  if (team?.protocol?.phase !== 'RETRO') failures.push(`retrospective has not closed (phase is ${team?.protocol?.phase ?? 'unknown'}, expected RETRO)`);
  if (greenRequired && String(greenEvidence).trim() === '') failures.push('fresh whole-suite green evidence is missing');
  return { ready: failures.length === 0, failures, coverage };
}

/** Bind the success claim to the exact cards, gate passes, coverage and green run. */
export function makeCompletionReceipt(team, greenEvidence, at = Date.now()) {
  const coverage = goalCoverage(team);
  const payload = {
    version: 1,
    teamId: team.id,
    useCases: coverage.rows.map(row => ({ ref: row.ref, tasks: row.completed })),
    tasks: team.tasks.map(task => ({ id: task.id, gatePassId: task.gatePassId })),
    // What shipped with a known gap, and where each residual now lives. A
    // receipt that only says "everything passed" cannot be audited against a
    // board that legitimately accepted or deferred something.
    residuals: residualLedger(team)
      .filter(row => row.disposition !== 'fixed')
      .map(row => ({ ref: row.ref, disposition: row.disposition, sink: row.sink, sinkRef: row.sinkRef })),
    greenEvidence: String(greenEvidence).trim(),
    retroAt: team.processLessons?.at,
    at,
  };
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return { id: `pair-complete:${digest}`, ...payload };
}
