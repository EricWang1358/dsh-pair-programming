/** Read-only, bounded browser projection of the canonical board. No model calls. */
import { goalCoverage } from '../protocol/coverage.js';
import { attentionSet, truncatedSeats } from '../protocol/attention.js';
import { gateStateFingerprint } from '../protocol/gate.js';
import { taskDesignContext } from '../protocol/design.js';

const cut = (value, max = 400) => typeof value === 'string' ? value.slice(0, max) : '';
const time = value => Number.isFinite(value) && Math.abs(value) <= 8640000000000000 ? value : null;
const done = task => task.status === 'completed';
function gateOf(team, task) {
  const pass = (team.protocol.gatePasses ?? []).filter(p => p.taskId === task.id).at(-1);
  return { recorded: !!task.gatePassId, current: !!pass && pass.id === task.gatePassId && pass.binding?.gateStateSha === gateStateFingerprint(team, task.id) };
}
function taskRow(team, task) {
  const cycles = team.protocol.cycles.filter(c => c.taskId === task.id);
  const cycle = cycles.at(-1);
  const gate = gateOf(team, task);
  const integrated = !!team.parallel?.integrations?.[task.id];
  const waits = (task.dependencies ?? []).filter(id => {
    const dependency = team.tasks.find(t => t.id === id);
    return !dependency || !done(dependency) || (team.parallel && !team.parallel.integrations?.[id]);
  });
  let stage = 'queued';
  if (done(task)) stage = 'done';
  else if (['failed', 'cancelled'].includes(task.status)) stage = task.status;
  else if (task.ready === false) stage = 'draft';
  else if (waits.length) stage = 'blocked';
  else if (cycle?.verify?.verdict === 'reject') stage = 'rework';
  else if (gate.current && team.parallel && !integrated) stage = 'integration';
  else if (gate.current) stage = 'completion';
  else if (cycle?.verify?.verdict === 'accept') stage = 'gate';
  else if (['GREEN', 'IMPLEMENTED', 'REFACTOR'].includes(cycle?.step)) stage = 'review';
  else if (cycle) stage = 'coding';
  else if (['claimed', 'in_progress'].includes(task.status)) stage = task.oracle ? 'coding' : 'spec';
  return { id: task.id, subject: cut(task.subject, 180), status: task.status, stage, owner: task.assignee ?? null,
    priority: task.priority ?? 2, dependencies: (task.dependencies ?? []).slice(0, 40), waits,
    oracle: !!task.oracle, gate, integrated, cycle: cycle ? { id: cycle.id, step: cycle.step, verdict: cycle.verify?.verdict ?? null } : null,
    cycles: cycles.length, updatedAt: time(task.updatedAt), acceptanceRefs: (task.acceptanceRefs ?? []).slice(0, 100) };
}
function timeline(team) {
  const events = [];
  for (const task of team.tasks) {
    events.push({ at: time(task.createdAt), kind: 'created', ref: task.id, text: cut(task.subject, 160) });
    const integration = team.parallel?.integrations?.[task.id];
    if (integration) events.push({ at: time(integration.at), kind: 'integrated', ref: task.id, text: cut(integration.head, 12) });
    if (done(task)) events.push({ at: time(task.updatedAt), kind: 'completed', ref: task.id, text: cut(task.subject, 160) });
  }
  for (const cycle of team.protocol.cycles) {
    events.push({ at: time(cycle.openedAt), kind: 'cycle', ref: cycle.taskId, text: cut(cycle.id) });
    if (cycle.verify) events.push({ at: time(cycle.verify.at), kind: cycle.verify.verdict ?? 'verified', ref: cycle.taskId, text: cut(cycle.id) });
    for (const repair of cycle.verificationRepairs ?? []) events.push({ at: time(repair.at), kind: 'repair', ref: cycle.taskId, text: cut(repair.reason, 160) });
  }
  return events.filter(e => e.at !== null).sort((a, b) => b.at - a.at).slice(0, 24);
}

export function projectPairPanel(team, { offset = 0, filter = 'all', query = '', taskId, maxResumes } = {}) {
  const rows = team.tasks.map(task => taskRow(team, task));
  const coverage = goalCoverage(team);
  const search = query.toLocaleLowerCase();
  const filtered = rows.filter(row => (!search || `${row.id} ${row.subject} ${row.owner ?? ''}`.toLocaleLowerCase().includes(search))
    && (filter === 'all' || (filter === 'done' ? row.stage === 'done' : filter === 'blocked' ? ['blocked', 'rework', 'failed'].includes(row.stage) : !['done', 'cancelled', 'failed', 'draft', 'queued'].includes(row.stage))));
  const attention = attentionSet(team, { maxResumes }).items;
  const parked = new Set(truncatedSeats(team, { maxResumes }).filter(s => s.exhausted).map(s => s.name));
  const discoveries = team.product?.discoveries ?? [];
  const selected = taskId ? team.tasks.find(t => t.id === taskId) : undefined;
  const latestCycles = selected ? team.protocol.cycles.filter(c => c.taskId === selected.id).slice(-12).reverse() : [];
  return {
    id: team.id, name: cut(team.name, 160), goal: cut(team.goal, 1200), mode: team.mode, phase: team.protocol.phase,
    updatedAt: time(team.updatedAt), parallel: !!team.parallel,
    counts: { total: rows.length, completed: rows.filter(r => r.stage === 'done').length,
      gateCurrent: rows.filter(r => r.gate.current).length, integrated: rows.filter(r => r.integrated).length,
      active: rows.filter(r => ['coding', 'spec', 'review', 'rework', 'gate', 'integration', 'completion'].includes(r.stage)).length,
      blocked: rows.filter(r => ['blocked', 'rework', 'failed'].includes(r.stage)).length,
      criteria: coverage.total, covered: coverage.completed, allocated: coverage.allocated, oracle: coverage.verified },
    tasks: { total: filtered.length, offset, limit: 24, rows: filtered.slice(offset, offset + 24) },
    members: team.members.slice(0, 12).map(member => ({ name: cut(member.name, 80), role: cut(member.role, 40), status: cut(member.status, 40),
      taskIds: rows.filter(r => r.owner === member.name && !['done', 'failed', 'cancelled'].includes(r.stage)).map(r => r.id),
      lastEnd: cut(typeof member.lastTurn?.endReason === 'string' ? member.lastTurn.endReason : member.lastTurn?.endReason?.kind, 80),
      parked: parked.has(member.name) })),
    attention: { total: attention.length, items: attention.slice(0, 8).map(item => ({ kind: cut(item.kind), who: cut(item.who, 80), ref: cut(item.ref, 120), tool: cut(item.tool, 80), why: cut(item.why, 600) })) },
    product: { untriaged: discoveries.filter(d => d.status === 'untriaged').length, deferred: discoveries.filter(d => d.status === 'deferred').length,
      items: discoveries.filter(d => d.status === 'untriaged').slice(0, 6).map(d => ({ id: d.id, observation: cut(d.observation, 240), value: cut(d.userValue, 240) })) },
    risks: (team.protocol.risks ?? []).filter(r => ['OPEN', 'MITIGATED'].includes(r.status)).slice(0, 8).map(r => ({ id: r.id, severity: r.severity, status: r.status, text: cut(r.scenario ?? r.observation ?? r.description ?? r.title, 300) })),
    riskTotal: (team.protocol.risks ?? []).filter(r => ['OPEN', 'MITIGATED'].includes(r.status)).length,
    history: timeline(team),
    selected: selected ? { ...rows.find(row => row.id === selected.id), description: cut(selected.description, 1600),
      criteria: (selected.story?.acceptance_criteria ?? []).slice(0, 60).map(c => cut(c, 600)),
      design: taskDesignContext(team, selected).slice(0, 10).map(d => ({ useCase: d.useCase,
        responsibility: cut(d.design?.responsibility, 400), approach: cut(d.design?.approach, 600),
        failure: cut(d.design?.failureBehavior, 600),
        interactions: d.interactions.slice(0, 12).map(i => ({ target: i.target, contract: cut(i.contract, 700), requires: i.requires.slice(0, 30) })) })),
      cycles: latestCycles.map(c => ({ id: c.id, step: c.step, verdict: c.verify?.verdict ?? null, repairs: c.verificationRepairs?.length ?? 0, at: time(c.openedAt) })) } : null,
  };
}
