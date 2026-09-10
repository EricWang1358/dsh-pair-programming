/** Observed milestones, not a claim that a fraction of the code is finished. */
export function panelProgress(team, rows) {
  const stages = rows.map(row => ['failed', 'cancelled'].includes(row.stage) ? Array(6).fill(false) : [
    row.oracle, !!row.cycle,
    ['GREEN','IMPLEMENTED','REFACTOR','VERIFIED'].includes(row.cycle?.step),
    row.cycle?.verdict === 'accept', row.gate.current, row.stage === 'done',
  ]);
  // Read each proof independently: a legacy completed card may lack a gate.
  const units = stages.reduce((sum, flags) => sum + flags.filter(Boolean).length, 0);
  const total = rows.length * 6;
  const finished = team.tasks.filter(t => t.status === 'completed');
  const starts = finished.map(t => Math.min(...team.protocol.cycles.filter(c => c.taskId === t.id)
    .map(c => c.openedAt).filter(Number.isFinite)));
  const samples = finished.map((task, i) => ({ start: starts[i], end: task.updatedAt }))
    .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
  const remaining = rows.filter(r => r.stage !== 'done').length;
  let eta = { reason: 'samples', samples: samples.length, minMinutes: null, maxMinutes: null };
  if (remaining === 0 && rows.length) eta = { ...eta, reason: 'complete', minMinutes: 0, maxMinutes: 0 };
  else if (['RETRO','DONE','ABORTED'].includes(team.protocol.phase) || rows.some(r => ['rework','failed','cancelled'].includes(r.stage))) eta.reason = 'blocked';
  else if (samples.length >= 3) {
    // Team throughput already includes observed overlap; never multiply by Driver count.
    const span = Math.max(...samples.map(s => s.end)) - Math.min(...samples.map(s => s.start));
    const minutes = span / samples.length * remaining / 60000;
    eta = { ...eta, reason: 'rough', minMinutes: Math.max(1, Math.floor(minutes * 0.5)), maxMinutes: Math.max(1, Math.ceil(minutes * 2)) };
  }
  return { percent: total ? Math.round(units / total * 1000) / 10 : 0, units, total,
    milestones: [0,1,2,3,4,5].map(step => stages.filter(flags => flags[step]).length),
    acceptedIncrements: team.protocol.cycles.filter(c => ['accept','checkpoint'].includes(c.verify?.verdict)).length,
    eta };
}
