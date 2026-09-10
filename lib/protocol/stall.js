/**
 * Stall detection: naming the fixed point the protocol can reach and never
 * leave on its own.
 *
 * The measured failure, reported from a live session: "消息进入队列但是刚好全部
 * 停止于是永久静默" — the Navigator posted a GO, the Driver's turn ended, every
 * seat went idle with mail pending, and nothing ever moved again. No error, no
 * API failure; the subagents stopped *normally*. The host even says so out
 * loud: "finished and will do no further work unless you send it more."
 *
 * That sentence is the whole problem. A stopped agent turn can only be
 * restarted by someone sending it a message, and the only party who can send
 * one is the captain — whose own turn ends exactly when it decides it is
 * "waiting". Two parties each waiting for the other is a fixed point, and the
 * The host can wake an idle captain with `agent.followup()`. The scheduler uses
 * that edge for real board obligations and keeps the heartbeat only as a
 * watchdog. Goal rounds are deliberately outside this liveness path: a goal
 * is an epic completion contract, not a polling clock.
 *
 * Pure logic — no imports, unit-testable.
 *
 * @module dsh-pair-programming/protocol/stall
 */

/** How long a board may sit unchanged with work owed before it is a stall. */
export const STALL_AFTER_MS = 180_000;
/** A working seat with no durable session activity this long needs inspection. */
export const WORKING_LEASE_MS = 600_000;

/**
 * The most recent moment anything on the board actually moved.
 *
 * Derived from the record rather than stored as a counter: a `lastProgressAt`
 * field would be one more thing that can disagree with the board, and this
 * project has already paid for that class of bug more than once.
 */
export function lastProgressAt(protocol = {}) {
  let latest = 0;
  const bump = (v) => { if (typeof v === 'number' && v > latest) latest = v; };
  for (const c of protocol.cycles ?? []) {
    bump(c.openedAt); bump(c.proposal?.at); bump(c.review?.at);
    bump(c.red?.at); bump(c.green?.at); bump(c.report?.at); bump(c.verify?.at);
  }
  for (const r of protocol.risks ?? []) { bump(r.openedAt); bump(r.mitigatedAt); bump(r.closedAt); }
  for (const d of protocol.decisions ?? []) bump(d.at);
  for (const g of protocol.gatePasses ?? []) bump(g.at);
  return latest;
}

/**
 * Diagnose the silent fixed point.
 *
 * @param {object} team - the durable team record.
 * @param {{now?:number, unread?:Record<string,number>, obligation?:object, thresholdMs?:number, workingLeaseMs?:number}} [opts]
 *   `unread` maps member name -> pending message count (the scheduler knows it;
 *   the predicate stays pure).
 * @returns {{stalled:boolean, quietMs:number, idle:string[], waiting:string[], owed?:object, reason:string}}
 */
export function stallDiagnosis(team, opts = {}) {
  const now = opts.now ?? Date.now();
  const threshold = opts.thresholdMs ?? STALL_AFTER_MS;
  const protocol = team?.protocol ?? {};
  const phase = protocol.phase;
  const live = (team?.members ?? []).filter(m => m.status !== 'removed' && m.id !== '');
  const idle = live.filter(m => m.status === 'idle').map(m => m.name);
  const unread = opts.unread ?? {};
  const waiting = Object.keys(unread).filter(name => (unread[name] ?? 0) > 0);
  const quietMs = now - (lastProgressAt(protocol) || team?.createdAt || now);
  const workingLease = opts.workingLeaseMs ?? WORKING_LEASE_MS;
  // The diagnosis names WHO is idle; this names WHAT they are idle on. It is
  // computed by the caller (protocol/obligation.js) because it needs the same
  // predicates the tools refuse with, and this module stays import-free.
  const blockingCause = opts.blockingCause;

  if (phase === 'DONE' || phase === 'ABORTED' || phase === 'RETRO') {
    return { stalled: false, quietMs, idle, waiting, reason: 'the team is wrapping up' };
  }
  if (live.length === 0) {
    return { stalled: false, quietMs, idle, waiting, reason: 'no live members' };
  }
  if (idle.length !== live.length) {
    const expiredWorking = live.filter(m => m.status === 'working'
      && now - (m.activity?.lastActivityAt ?? m.activity?.startedAt ?? team?.updatedAt ?? team?.createdAt ?? now) >= workingLease);
    if (expiredWorking.length > 0) {
      return {
        stalled: true, quietMs, idle, waiting, owed: opts.obligation, blockingCause,
        expiredWorking: expiredWorking.map(m => m.name),
        reason: `${expiredWorking.map(m => m.name).join(', ')} still reports working but its session produced no durable activity for at least ${Math.round(workingLease / 1000)}s`,
      };
    }
    return { stalled: false, quietMs, idle, waiting, reason: `${live.length - idle.length} member(s) still working` };
  }
  // Everyone is idle. That is only a stall if something is actually owed.
  const owed = opts.obligation;
  if (waiting.length === 0 && owed === undefined) {
    return { stalled: false, quietMs, idle, waiting, reason: 'nothing is owed — the team is genuinely at rest' };
  }
  if (quietMs < threshold) {
    return { stalled: false, quietMs, idle, waiting, owed, reason: `quiet for ${Math.round(quietMs / 1000)}s, under the ${Math.round(threshold / 1000)}s threshold` };
  }
  return {
    stalled: true, quietMs, idle, waiting, owed, blockingCause,
    reason: `every live seat is idle, ${waiting.length > 0 ? `mail is pending for ${waiting.join(', ')}` : 'a protocol step is owed'}, and nothing has moved for ${Math.round(quietMs / 1000)}s`,
  };
}

/**
 * The escalation text handed to the captain when the sweep cannot clear a
 * stall itself. Deliberately an instruction with a named next call, not a
 * notification: a captain that reads "something seems stuck" will reply to the
 * user and end its turn, which is the very move that created the fixed point.
 */
export function stallEscalation(teamId, diagnosis, obligationText) {
  // "Idle seats: driver, navigator, challenger. Mail pending for: nobody." was
  // the whole content of two live stall reports, and it sent the Captain back
  // to the same call it had already failed to make. The cause is what turns
  // "everybody is idle" into a decision.
  const cause = diagnosis.blockingCause;
  const causeLines = cause === undefined ? [] : [
    `blocking cause: ${cause.who} owes ${cause.tool}(${cause.ref ?? '-'})`
      + (cause.blocking.length === 0 ? '.' : ' — ' + cause.blocking.join('; ') + '.'),
    ...cause.blocked_work.slice(0, 4).map(row => `  ready but held up: ${row.taskId} — ${row.reason}`),
    `suggested action: ${cause.suggested_action}`,
  ];
  return [
    `[PAIR:STALL] team ${teamId} needs captain action after ${Math.round(diagnosis.quietMs / 1000)}s without board progress.`,
    `Idle seats: ${diagnosis.idle.join(', ') || 'none'}. Mail pending for: ${diagnosis.waiting.join(', ') || 'nobody'}.`,
    obligationText ?? '',
    ...causeLines,
    '',
    diagnosis.expiredWorking?.length > 0
      ? `Inspect the recorded last-turn/activity data for ${diagnosis.expiredWorking.join(', ')}. Interrupt only if the session really stopped making progress; long turns with new session events keep their lease.`
      : 'Read pair_status, validate that the named call is still owed, then send the responsible seat one concise correction. The board outranks an old mailbox instruction.',
  ].filter(Boolean).join('\n');
}

/**
 * What the captain is told at pair_start about arming harness-level liveness.
 *
 * This is the honest boundary of what a plugin can promise: the scheduler can
 * wake a member while the captain's turn is live, and it can shout when it
 * cannot, but only the harness's own re-invocation loop can restart a captain
 * that has stopped. If your host offers a goal/objective loop, arming it is
 * what converts "silent forever" into "checked again shortly".
 */
export function goalLoopAdvice(teamId) {
  return [
    `Liveness for team ${teamId} is board-event driven: member reports, verdicts, errors, and watchdog findings wake an idle captain with a follow-up; running captains receive a steer.`,
    'Do not create a goal or wall-clock schedule merely to poll pair_status. A goal may hold the epic, but it completes only from pair_stop(outcome="complete") and its completion_receipt; use a low-frequency schedule only as an external watchdog if the host process itself may die.',
    'Every requirement belongs in pair_start.use_cases, every UC-N.AC-N belongs on a task card, and the status coverage matrix is the progress source.',
  ].join(' ');
}
