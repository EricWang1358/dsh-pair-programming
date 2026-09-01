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

export const PHASES = Object.freeze(['FORMING', 'PLANNING', 'CYCLING', 'TASK_GATE', 'RETRO', 'DONE']);

/** The allowed phase transitions. */
const PHASE_TRANSITIONS = {
  FORMING: ['PLANNING'],
  PLANNING: ['CYCLING', 'DONE'],
  CYCLING: ['TASK_GATE', 'RETRO', 'DONE'],
  TASK_GATE: ['CYCLING', 'RETRO'],
  RETRO: ['DONE'],
  DONE: [],
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

/** Create the initial protocol record for a fresh team. */
export function initialProtocolState() {
  return {
    phase: 'FORMING',
    currentTaskId: undefined,
    currentCycle: undefined,
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
    red: undefined,
    green: undefined,
    report: undefined,
    verify: undefined,
  };
  protocol.currentTaskId = taskId;
  protocol.currentCycle = cycle;
  protocol.cycles.push(cycle);
  return cycle;
}

/** The step chain for a legacy (test-after) cycle. */
const CHAIN_OFF = ['PROPOSED', 'GO', 'IMPLEMENTED', 'VERIFIED', 'RISK_CHECKED', 'CLOSED'];
/** The step chain when tddMode=enforce: Test First (Red-Green-Refactor, XP/TDD rule I7). */
const CHAIN_TDD = ['PROPOSED', 'GO', 'RED', 'GREEN', 'REFACTOR', 'VERIFIED', 'RISK_CHECKED', 'CLOSED'];
/** Trivially-sized tasks skip the risk-check hop (the "when NOT to pair" rule). */
const CHAIN_TRIVIAL = ['PROPOSED', 'GO', 'IMPLEMENTED', 'VERIFIED', 'CLOSED'];

/**
 * Resolve the allowed step chains for one cycle: its own stamped mode wins (so
 * cycles created under an older session keep progressing), falling back to
 * opts. enforce = TDD chain only; off = legacy chain only; coach = both chains
 * (the TDD order is available and recommended but a plain report also passes).
 */
export function cycleChains(cycle, opts = {}) {
  const mode = cycle?.tddMode ?? opts.tddMode ?? 'off';
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

/** Consecutive clean cycles before the protocol suggests enlarging step size. */
export const ENLARGE_AFTER = 3;
/** Rejections on one cycle before the protocol forces a smaller step. */
export const SHRINK_AFTER = 2;

/**
 * Assess granularity from recent cycle history.
 * @param {Array} cycles - the team's cycle records.
 * @returns {{signal:'enlarge'|'shrink'|'steady', reason:string}}
 */
export function granularitySignal(cycles) {
  const closed = cycles.filter(c => c.step === 'CLOSED');
  const recent = closed.slice(-ENLARGE_AFTER);
  const cleanStreak = recent.length === ENLARGE_AFTER
    && recent.every(c => (c.rejections ?? 0) === 0 && (c.attacks ?? 0) === 0);
  if (cleanStreak) {
    return { signal: 'enlarge', reason: `${ENLARGE_AFTER} consecutive clean cycles — consider a larger step` };
  }
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
  const planned = protocol.decisions.filter(d => (d.taskId === taskId || namesTask(d.conflictRef, taskId)) && (d.at ?? 0) <= freezeAt);
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

