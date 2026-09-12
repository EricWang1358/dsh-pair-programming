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
function estimate(team, rows, stamps, score = {}) {
  const cycles = team.protocol.cycles ?? [];
  const settled = cycles.filter(c => ['accept', 'checkpoint'].includes(c.verify?.verdict) && Number.isFinite(c.verify.at))
    .sort((a, b) => a.verify.at - b.verify.at);
  const open = rows.filter(r => !['done', 'failed', 'cancelled'].includes(r.stage));
  const moved = cycles.flatMap(stepStamps);
  const eta = { reason: 'samples', samples: settled.length, minutes: null, floorMinutes: null, rounds: null, paceMs: null,
    at: moved.length ? Math.max(...moved) : null };
  // "Nothing is in play" and "everything got done" are not the same board, and #133 made the
  // difference visible: a stopped card leaves the denominator, so a board whose cards were ALL
  // stopped reads 0% over "0 / 0" — and an estimate saying "All done" beside it was the third
  // contradictory reading of one board (measured on demoBoard with every card cancelled: percent 0,
  // scored 0, terminated 8, reason 'complete'). The all-stopped case gets its own reason; a board
  // that still has cards in play, all of them done, keeps 'complete' (#164).
  if (rows.length && rows.every(r => ['failed', 'cancelled'].includes(r.stage))) return { ...eta, reason: 'terminated' };
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
  const byRounds = Math.max(1, Math.ceil(rounds * paceMs / 60000));
  // The other way to read the same board: how fast the six scored stages actually turn over.
  //
  // A per-round pace counts ROUNDS, and before any card has finished "typical" is one round per
  // card, while the round it prices excludes the freeze, the gate and the merge — all of which earn
  // score units and all of which every card must pass. Measured on SG-career: 12 active minutes,
  // 0 of 5 cards done, "about 14 minutes left". The two readings are both honest, so the estimate
  // takes the larger and names which one it came from instead of quietly preferring the friendlier.
  //
  // Because units are earned by the freeze, the gate and the merge as well as by the coding, a card
  // that has finished contributes its whole cost — freezing, verifying, gating, merging — to the
  // rate. That is the per-card calibration, in aggregate, without a second accumulator.
  // The rate's denominator is the SAME set of cards the numerator scores (item 13).
  const activeTotal = activeSpan(score.rateStamps ?? stamps);
  const rate = Number.isFinite(score.units) && score.units > 0 && activeTotal.activeMs > 0
    ? score.units / activeTotal.activeMs : 0;
  const throughputMinutes = rate > 0 ? Math.ceil(Math.max(0, (score.total ?? 0) - score.units) / rate / 60000) : 0;
  const minutes = Math.max(byRounds, throughputMinutes);
  return { ...eta, reason: 'rough', paceMs: Math.round(paceMs), rounds: Math.round(rounds * 10) / 10, minutes,
    byRounds, throughputMinutes, basis: throughputMinutes > byRounds ? 'throughput' : 'rounds',
    floorMinutes: Math.min(minutes, Math.max(1, Math.ceil(unopened * paceMs / 60000))) };
}

export function panelProgress(team, rows, stamps = [], opts = {}) {
  // A stopped card is out of the denominator. It can never light another milestone, so counting it
  // is not "unfinished work" — it is a permanent 0 that reads as permanent failure: measured on
  // SG-career, where one failed and one cancelled card held the disc at "0% · 0/11" and every
  // hand-off to a fresh card dropped the number again. The count is reported, not hidden.
  const live = rows.filter(row => !['failed', 'cancelled'].includes(row.stage));
  const terminated = rows.length - live.length;
  const stages = live.map(row => [
    row.oracle, !!row.cycle,
    ['GREEN','IMPLEMENTED','REFACTOR','VERIFIED'].includes(row.cycle?.step),
    row.cycle?.verdict === 'accept', row.gate.current, row.stage === 'done',
  ]);
  // Read each proof independently: a legacy completed card may lack a gate.
  const units = stages.reduce((sum, flags) => sum + flags.filter(Boolean).length, 0);
  const total = live.length * 6;
  return { percent: total ? Math.round(units / total * 1000) / 10 : 0, units, total, scored: live.length, terminated,
    milestones: [0,1,2,3,4,5].map(step => stages.filter(flags => flags[step]).length),
    acceptedIncrements: team.protocol.cycles.filter(c => ['accept','checkpoint'].includes(c.verify?.verdict)).length,
    active: activeSpan(stamps), eta: estimate(team, rows, stamps, { units, total, rateStamps: opts.rateStamps }) };
}
