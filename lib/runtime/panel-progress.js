/** Observed milestones, not a claim that a fraction of the code is finished. */
const IDLE_GAP_MS = 45 * 60000;
const PACE_ROUNDS = 8;

/** Active time over recorded board timestamps: a stretch with no record for longer than gapMs is idle, not work. */
export function activeSpan(stamps, gapMs = IDLE_GAP_MS) {
  const sorted = stamps.filter(Number.isFinite).sort((a, b) => a - b);
  let activeMs = 0;
  for (let i = 1; i < sorted.length; i++) if (sorted[i] - sorted[i - 1] <= gapMs) activeMs += sorted[i] - sorted[i - 1];
  return { activeMs, lastAt: sorted.length ? sorted[sorted.length - 1] : null, gapMs };
}

/** How far a still-open round has got, by protocol step. A round rewound by a rejection restarts low. */
const STEP_DONE = { PROPOSED: 0.1, GO: 0.3, RED: 0.45, IMPLEMENTED: 0.7, GREEN: 0.7, REFACTOR: 0.85 };
const stepStamps = c => [c.openedAt, c.review?.at, c.red?.at, c.green?.at, c.report?.at, c.verify?.at,
  ...(c.verificationRepairs ?? []).map(r => r.at)].filter(Number.isFinite);

/**
 * Remaining time from the recent check pace, recalculated whenever a round moves a step.
 * Pace is team throughput over the latest settled rounds (accept or checkpoint), so parallel Drivers are already
 * in it and it is never multiplied by Driver count. Rounds are opened as work reveals itself: "typical" is what
 * tasks through final review took, or, before any got there, the most any open task has needed so far. Every
 * unfinished task owes at least one more round, and an open round is credited for the steps it has passed.
 * `at` is the latest step, from which the panel counts down with active time; `floorMinutes` is the time for
 * rounds not yet opened, which that countdown never eats into. A rough guide that moves with the board.
 */
function estimate(team, rows, stamps) {
  const cycles = team.protocol.cycles ?? [];
  const settled = cycles.filter(c => ['accept', 'checkpoint'].includes(c.verify?.verdict) && Number.isFinite(c.verify.at))
    .sort((a, b) => a.verify.at - b.verify.at);
  const open = rows.filter(r => !['done', 'failed', 'cancelled'].includes(r.stage));
  const moved = cycles.flatMap(stepStamps);
  const eta = { reason: 'samples', samples: settled.length, minutes: null, floorMinutes: null, rounds: null, paceMs: null,
    at: moved.length ? Math.max(...moved) : null };
  if (!open.length && rows.length) return { ...eta, reason: 'complete', minutes: 0, floorMinutes: 0, rounds: 0 };
  if (['RETRO', 'DONE', 'ABORTED'].includes(team.protocol.phase)) return { ...eta, reason: 'stopped' };
  const recent = settled.slice(-PACE_ROUNDS);
  if (!recent.length) return eta;
  const lastSettled = recent[recent.length - 1].verify.at;
  const from = Math.min(...recent.map(c => Number.isFinite(c.openedAt) ? Math.min(c.openedAt, c.verify.at) : c.verify.at));
  const window = activeSpan(stamps.filter(at => at >= from && at <= lastSettled));
  if (!(window.activeMs > 0)) return eta;
  const paceMs = Math.max(60000, window.activeMs / recent.length);
  const roundsOf = id => settled.filter(c => c.taskId === id).length;
  const reviewed = rows.filter(r => cycles.some(c => c.taskId === r.id && c.verify?.verdict === 'accept'));
  const typical = reviewed.length ? reviewed.reduce((n, r) => n + roundsOf(r.id), 0) / reviewed.length
    : Math.max(1, ...open.map(r => roundsOf(r.id)));
  let rounds = 0, unopened = 0;
  for (const row of open) {
    const owed = ['gate', 'completion', 'integration'].includes(row.stage) ? 0.5 : Math.max(1, typical - roundsOf(row.id));
    const latest = cycles.filter(c => c.taskId === row.id).at(-1);
    const passed = latest && !['accept', 'checkpoint'].includes(latest.verify?.verdict) ? STEP_DONE[latest.step] : undefined;
    rounds += passed === undefined ? owed : Math.max(0, owed - passed);
    unopened += passed === undefined ? owed : Math.max(0, owed - 1);
  }
  const minutes = Math.max(1, Math.ceil(rounds * paceMs / 60000));
  return { ...eta, reason: 'rough', paceMs: Math.round(paceMs), rounds: Math.round(rounds * 10) / 10, minutes,
    floorMinutes: Math.min(minutes, Math.max(1, Math.ceil(unopened * paceMs / 60000))) };
}

export function panelProgress(team, rows, stamps = []) {
  const stages = rows.map(row => ['failed', 'cancelled'].includes(row.stage) ? Array(6).fill(false) : [
    row.oracle, !!row.cycle,
    ['GREEN','IMPLEMENTED','REFACTOR','VERIFIED'].includes(row.cycle?.step),
    row.cycle?.verdict === 'accept', row.gate.current, row.stage === 'done',
  ]);
  // Read each proof independently: a legacy completed card may lack a gate.
  const units = stages.reduce((sum, flags) => sum + flags.filter(Boolean).length, 0);
  const total = rows.length * 6;
  return { percent: total ? Math.round(units / total * 1000) / 10 : 0, units, total,
    milestones: [0,1,2,3,4,5].map(step => stages.filter(flags => flags[step]).length),
    acceptedIncrements: team.protocol.cycles.filter(c => ['accept','checkpoint'].includes(c.verify?.verdict)).length,
    active: activeSpan(stamps), eta: estimate(team, rows, stamps) };
}
