/** Terminal success/abort semantics and the durable completion receipt. */
import { createHash } from 'node:crypto';
import { goalCoverage } from './coverage.js';
import { openBlockingRisks } from './risks.js';

/** Explain every condition that still prevents a successful team completion. */
export function completionReadiness(team, { greenRequired = true, greenEvidence = '' } = {}) {
  const failures = [];
  const tasks = team?.tasks ?? [];
  if (tasks.length === 0) failures.push('the board has no task cards');
  const notCompleted = tasks.filter(task => task.status !== 'completed');
  if (notCompleted.length > 0) failures.push(`task(s) are not completed: ${notCompleted.map(task => `${task.id}[${task.status}]`).join(', ')}`);
  const passes = team?.protocol?.gatePasses ?? [];
  const withoutPass = tasks.filter(task => task.status === 'completed'
    && !passes.some(pass => pass.id === task.gatePassId && pass.taskId === task.id));
  if (withoutPass.length > 0) failures.push(`completed task(s) lack their exact gate credential: ${withoutPass.map(task => task.id).join(', ')}`);
  const blocking = openBlockingRisks(team?.protocol ?? {}, ['P0', 'P1']);
  if (blocking.length > 0) failures.push(`blocking risk(s) remain: ${blocking.map(risk => `${risk.id}(${risk.severity}/${risk.status})`).join(', ')}`);
  const coverage = goalCoverage(team);
  if (coverage.total === 0) failures.push('the epic has no enumerated use cases');
  if (coverage.missingAllocation.length > 0) failures.push(`unallocated goal criteria: ${coverage.missingAllocation.join(', ')}`);
  if (coverage.missingOracle.length > 0) failures.push(`goal criteria lack executable oracle cases: ${coverage.missingOracle.join(', ')}`);
  if (coverage.incomplete.length > 0) failures.push(`goal criteria are not completed: ${coverage.incomplete.join(', ')}`);
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
    greenEvidence: String(greenEvidence).trim(),
    retroAt: team.processLessons?.at,
    at,
  };
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return { id: `pair-complete:${digest}`, ...payload };
}
