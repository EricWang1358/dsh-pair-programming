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
 * plugin's own heartbeat cannot break it: `kickMember` needs a live captain to
 * parent the follow-up, so when the captain's turn has ended the sweep runs,
 * finds nothing it may do, and returns silently. Forever, once a minute.
 *
 * A plugin cannot restart a conversation the harness has ended. What it can do
 * is refuse to be quiet about it: detect the fixed point, name who owes what,
 * and hand the captain a re-entry it can act on. Liveness itself has to come
 * from the harness loop (see `goalLoopAdvice`).
 *
 * Pure logic — no imports, unit-testable.
 *
 * @module dsh-pair-programming/protocol/stall
 */

/** How long a board may sit unchanged with work owed before it is a stall. */
export const STALL_AFTER_MS = 180_000;

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
 * @param {{now?:number, unread?:Record<string,number>, obligation?:object, thresholdMs?:number}} [opts]
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

  if (phase === 'DONE' || phase === 'RETRO') {
    return { stalled: false, quietMs, idle, waiting, reason: 'the team is wrapping up' };
  }
  if (live.length === 0) {
    return { stalled: false, quietMs, idle, waiting, reason: 'no live members' };
  }
  if (idle.length !== live.length) {
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
    stalled: true, quietMs, idle, waiting, owed,
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
  return [
    `[PAIR:STALL] team ${teamId} has been silent for ${Math.round(diagnosis.quietMs / 1000)}s and cannot restart itself.`,
    `Idle seats: ${diagnosis.idle.join(', ') || 'none'}. Mail pending for: ${diagnosis.waiting.join(', ') || 'nobody'}.`,
    obligationText ?? '',
    '',
    'Why this needs you: a subagent whose turn has ended does no further work until something sends it a message, and the scheduler can only send one while your own turn is live. Both of you waiting is a fixed point the plugin cannot break from inside.',
    'Do this now, in this turn: send the owed party a one-line message naming the call it owes (the [PAIR:NEXT] line above is that call, verbatim). Do not reply to the user and end your turn while a step is owed — that is what made it quiet.',
    'If you have not already: register a completion goal for this team so the harness re-enters you when you stop, instead of leaving the board frozen (see pair_start output).',
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
    `Liveness: the scheduler wakes members only while your turn is live. When you stop with work outstanding, nothing restarts the team — a stalled board stays stalled.`,
    `Before you go idle, arm your host's autonomous loop (e.g. create_goal) with the objective "drive pair team ${teamId} until every task is terminal and the green build passes", so the harness re-enters you instead of leaving the protocol frozen.`,
    `Then monitor event-driven as usual: act on GREEN / RAISE / NO_GO / STALL, never busy-poll pair_status.`,
  ].join(' ');
}
