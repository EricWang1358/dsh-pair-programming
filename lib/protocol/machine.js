/**
 * Session-level protocol state machine: phases, transitions, and the
 * granularity controller (adaptive cycle size + per-task cycle budget).
 *
 * Pure logic, no cordis / I/O imports — unit-testable.
 *
 * Phases:
 *   IDLE ──pair_start──► FORMING ──members ready──► PLANNING ──plan decided──► CYCLING
 *                                                          CYCLING ──all tasks terminal──► RETRO ──► DONE
 *   TASK_GATE is a transient sub-state entered at each task completion check.
 *
 * @module dsh-pair-programming/protocol/machine
 */

import { isBookkeepingRuling } from './disclosure.js';

export const PHASES = Object.freeze(['FORMING', 'PLANNING', 'CYCLING', 'TASK_GATE', 'RETRO', 'DONE', 'ABORTED']);

/** No new member work or replacement may start while wrapping up. */
export function isDispatchClosed(phase) {
  return phase === 'DONE' || phase === 'ABORTED' || phase === 'RETRO';
}

/** The allowed phase transitions. */
const PHASE_TRANSITIONS = {
  FORMING: ['PLANNING'],
  PLANNING: ['CYCLING', 'ABORTED'],
  CYCLING: ['TASK_GATE', 'RETRO', 'ABORTED'],
  TASK_GATE: ['CYCLING', 'RETRO', 'ABORTED'],
  RETRO: ['DONE', 'ABORTED'],
  DONE: [],
  ABORTED: [],
};

/**
 * Validate one phase transition.
 * @returns {string|undefined} the transition error, or undefined when allowed.
 */
export function phaseTransitionError(current, next) {
  if (current === next) return undefined;
  if (!PHASE_TRANSITIONS[current]?.includes(next)) {
    return `protocol phase cannot move from "${current}" to "${next}"`;
  }
  return undefined;
}

/**
 * Advance the session phase to match what the board actually shows.
 *
 * Measured failure: across two full v3 sessions `pair_status` reported
 * `phase PLANNING` on all 22 reads, including one that also reported 3/3 tasks
 * done — because only pair_start/pair_retro/pair_stop ever assigned a phase and
 * CYCLING/TASK_GATE were assigned by nothing. A phase that never moves is not a
 * state machine, it is a decoration, and it made the captain guess where the
 * team was instead of reading it.
 *
 * Called on the transitions that are unambiguous; RETRO and DONE stay explicit
 * because they are decisions, not consequences.
 *
 * @returns {boolean} whether the phase changed.
 */
export function advancePhase(protocol, to) {
  if (protocol.phase === to) return false;
  if (protocol.phase === 'RETRO' || protocol.phase === 'DONE' || protocol.phase === 'ABORTED') return false;
  if (phaseTransitionError(protocol.phase, to) !== undefined) return false;
  protocol.phase = to;
  return true;
}

/** Create the initial protocol record for a fresh team. */
export function initialProtocolState() {
  return {
    phase: 'FORMING',
    currentTaskId: undefined,
    cycles: [],
    risks: [],
    decisions: [],
    gatePasses: [],
    stats: { noGo: 0, reject: 0, attacks: 0, cacheHits: 0, cacheMiss: 0, reasons: {} },
  };
}

/* ------------------------------------------------------------------------- */
/* Cycle lifecycle                                                             */
/* ------------------------------------------------------------------------- */

let cycleSeq = 0;

/**
 * Open a new cycle for one task; returns the cycle record.
 * The tddMode/trivial stamps ride with the cycle so a mid-session mode change
 * never strands an in-flight cycle on the wrong step chain.
 * @param {object} protocol
 * @param {string} taskId
 * @param {{tddMode?:string, trivial?:boolean}} [opts]
 */
export function openCycle(protocol, taskId, opts = {}) {
  cycleSeq += 1;
  const cycle = {
    id: `c-${taskId}-${protocol.cycles.filter(c => c.taskId === taskId).length + 1}-${cycleSeq}`,
    taskId,
    step: 'PROPOSED',
    tddMode: opts.tddMode ?? 'off',
    trivial: opts.trivial === true,
    openedAt: Date.now(),
    proposal: undefined,
    review: undefined,
    oracleSha: opts.oracleSha,
    red: undefined,
    green: undefined,
    report: undefined,
    verify: undefined,
  };
  protocol.currentTaskId = taskId;
  protocol.cycles.push(cycle);
  return cycle;
}

/** The canonical current-cycle pointer: the last-opened cycle, derived from cycles[] — never a second stored state. */
export function currentCycleOf(protocol) {
  return protocol.cycles[protocol.cycles.length - 1];
}

/** The step chain for a legacy (test-after) cycle. */
const CHAIN_OFF = ['PROPOSED', 'GO', 'IMPLEMENTED', 'VERIFIED', 'RISK_CHECKED', 'CLOSED'];
/** The step chain when tddMode=enforce: Test First (Red-Green-Refactor, XP/TDD rule I7). */
const CHAIN_TDD = ['PROPOSED', 'GO', 'RED', 'GREEN', 'REFACTOR', 'VERIFIED', 'RISK_CHECKED', 'CLOSED'];
/** Trivially-sized tasks skip the risk-check hop (the "when NOT to pair" rule). */
const CHAIN_TRIVIAL = ['PROPOSED', 'GO', 'IMPLEMENTED', 'VERIFIED', 'CLOSED'];
/**
 * The v3 oracle chain (N1 + R5). RED is not a Driver step here: the cycle
 * inherits the RED the frozen oracle already produced, so the Driver goes
 * straight to the minimal GREEN. REFACTOR is folded into GREEN — across eight
 * measured rounds no separate refactor round changed a byte that mattered,
 * and it cost one member wake per cycle.
 */
const CHAIN_ORACLE = ['PROPOSED', 'GO', 'GREEN', 'VERIFIED'];

/**
 * Resolve the allowed step chains for one cycle: its own stamped mode wins (so
 * cycles created under an older session keep progressing), falling back to
 * opts. enforce = TDD chain only; off = legacy chain only; coach = both chains
 * (the TDD order is available and recommended but a plain report also passes).
 */
export function cycleChains(cycle, opts = {}) {
  const mode = cycle?.tddMode ?? opts.tddMode ?? 'off';
  // A cycle carrying a frozen oracle runs the v3 chain whatever the tdd mode
  // says: its RED is the oracle's, and it cannot be re-authored downstream.
  // Oracle check must precede the trivial shortcut; otherwise a trivial-oracle
  // cycle strands on a chain without GREEN (no legal GREEN/verify path).
  if (cycle?.oracleSha !== undefined) return [CHAIN_ORACLE];
  if (cycle?.trivial || opts.trivial) return [CHAIN_TRIVIAL];
  if (mode === 'enforce') return [CHAIN_TDD];
  if (mode === 'coach') return [CHAIN_OFF, CHAIN_TDD];
  return [CHAIN_OFF];
}

/** Back-compat helper: the primary chain for a cycle. */
export function cycleChain(cycle, opts = {}) {
  return cycleChains(cycle, opts)[0];
}

/**
 * Validate one cycle step move.
 * @param {object} cycle - the cycle record (may carry tddMode/trivial stamps).
 * @param {string} next - the step to move to.
 * @param {{tddMode?:string, trivial?:boolean}} [opts] - session-level defaults.
 * @returns {string|undefined} the error, or undefined when allowed.
 */
export function cycleStepError(cycle, next, opts = {}) {
  const chains = cycleChains(cycle, opts);
  const label = () => chains.map(c => c.join(' -> ')).join(' | ');
  const fromAny = chains.map(c => c.indexOf(cycle.step)).some(i => i >= 0);
  if (!fromAny) return `cycle step "${cycle.step}" is not on the chain (${label()}) for this cycle`;
  // A rejected/no-go cycle resets to PROPOSED; that is the only backward edge.
  if (next === 'PROPOSED') return undefined;
  let known = false;
  for (const chain of chains) {
    const from = chain.indexOf(cycle.step);
    const to = chain.indexOf(next);
    if (to >= 0) known = true;
    // Strict adjacency: a cycle advances one step at a time within its chain,
    // so no member can skip PROPOSE / VERIFY / RISK_CHECK (or RED/GREEN under
    // TDD) to jump ahead.
    if (from >= 0 && to === from + 1) return undefined;
  }
  if (!known) return `unknown cycle step "${next}" for this cycle's chain (${label()})`;
  return `cycle step must advance one at a time (cannot move from "${cycle.step}" to "${next}")`;
}

/**
 * The cycle budget for one task: spikes are a hard little timebox (default 2
 * cycles), everything else uses the session cap.
 */
export function cycleBudgetForTask(task, { maxCyclesPerTask, spikeMaxCycles = 2 } = {}) {
  return task?.type === 'spike' ? spikeMaxCycles : maxCyclesPerTask;
}

/* ------------------------------------------------------------------------- */
/* Granularity controller                                                      */
/* ------------------------------------------------------------------------- */

/** @deprecated Compatibility export; clean cycles no longer widen implementation scope. */
export const ENLARGE_AFTER = 3;
/** Rejections on one cycle before the protocol forces a smaller step. */
export const SHRINK_AFTER = 2;

/**
 * Assess granularity from recent cycle history.
 * @param {Array} cycles - the team's cycle records.
 * @returns {{signal:'shrink'|'steady', reason:string}}
 */
export function granularitySignal(cycles) {
  // Rejection can prove a step is too large, so it may force a split. A clean
  // streak cannot prove that a larger change remains reviewable. The former
  // "3 clean -> enlarge" hint contradicted I2 in a measured art project: full
  // oracle verification already pushed cycles to 200-330 lines, and the
  // controller then asked for still larger steps. Clean work now stays small.
  const active = cycles[cycles.length - 1];
  if (active !== undefined && (active.rejections ?? 0) >= SHRINK_AFTER) {
    return { signal: 'shrink', reason: `cycle rejected ${active.rejections} times — force a smaller step` };
  }
  return { signal: 'steady', reason: 'granularity is appropriate' };
}

/**
 * Whether one task has exhausted its cycle budget.
 * @param {Array} cycles
 * @param {string} taskId
 * @param {number} maxCyclesPerTask
 */
export function cycleBudgetExhausted(cycles, taskId, maxCyclesPerTask) {
  return cycles.filter(c => c.taskId === taskId).length >= maxCyclesPerTask;
}

/**
 * Planning arbitrations spent on one task: attributed by stored `taskId` or a
 * stored `conflictRef` naming it (task_id is optional; unattributed rulings are the
 * loophole), inside a window closing at the task's FIRST cycle so mid-work rulings
 * stay legal. No `at`? count it — tighten on doubt.
 */
/** Whether a text names a task as a whole token; t-1 never matches t-10. */
export function namesTask(text, taskId) {
  return `-${String(text ?? '').replace(/[^A-Za-z0-9-]+/g, '-')}-`.includes(`-${taskId}-`);
}

export function planningArbitrationsUsed(protocol, taskId) {
  const cycles = protocol.cycles.filter(c => c.taskId === taskId);
  const freezeAt = cycles.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...cycles.map(c => c.openedAt ?? 0));
  // A ruling that only discharged a declared disclosure is the board's own
  // paperwork (a successful stop is refused while any gap is unclaimed), so it is
  // not a dispute against this task's planning allowance. The rule lives in
  // disclosure.js and the enforcement point filters with the same predicate, so
  // the counter and the refusal can no longer disagree about what was charged.
  const planned = protocol.decisions.filter(d => !isBookkeepingRuling(d) && (d.taskId === taskId || namesTask(d.conflictRef, taskId)) && (d.at ?? 0) <= freezeAt);
  return { count: planned.length, decided: planned.map(d => d.id), workStarted: cycles.length > 0 };
}

/**
 * The per-task planning budget. Unlike maxOpenRisks there is no 0 kill switch (0 =
 * "plan without resolving", the waterfall this prevents), so a bad cap throws. The
 * refusal rides on the result: one call site, unlike raiseBudgetMessage.
 */
export function planBudgetExhausted(protocol, taskId, cap) {
  if (!Number.isInteger(cap) || cap < 1) throw new Error(`planningMaxArbitrations must be an integer >= 1 (got ${String(cap)})`);
  const used = planningArbitrationsUsed(protocol, taskId);
  return { ...used, cap, exhausted: used.count >= cap, pickSideRequired: used.count >= cap, refusal: `task "${taskId}" used ${used.count} of ${cap} planning arbitrations (${used.decided.join(', ') || 'none'}) — pick a side in the record, or move the leftover dispute into a risk ticket; spec ${used.workStarted ? 'is frozen (the task has cycles)' : 'is not frozen yet'}.` };
}

/** Whether one task's spec is frozen: any cycle for that task, never the global phase. */
export function specFrozen(protocol, taskId) {
  return protocol.cycles.some(c => c.taskId === taskId);
}
