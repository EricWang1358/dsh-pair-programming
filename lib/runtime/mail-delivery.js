/**
 * One durable notification batch: at most 8 logical records and 16 KiB UTF-8 INCLUDING
 * envelope, references, board summary and current NEXT. JSONL retains complete
 * content, even after host acceptance; pair_mailbox_read pages it by owned id.
 * ACK means host admission, never model consumption or task completion.
 */
import { decodeMessage, withoutLegacyNext } from '../protocol/messages.js';
import { nextObligation, obligationLine } from '../protocol/obligation.js';
import { isDispatchClosed } from '../protocol/machine.js';
import { collapseUnread } from './collapse.js';
import { readTeam } from '../state/store.js';
import { readUnreadMailbox, claimMailboxDelivery, acknowledgeMailbox, releaseMailboxDelivery } from '../state/mailbox.js';
import { withLock } from '../state/lock.js';
import { teamLockKey } from '../state/layout.js';

export const DELIVERY_MAX_MESSAGES = 8;
export const DELIVERY_MAX_BYTES = 16 * 1024;
const CONTROL = new Set(['REJECT', 'NO_GO', 'ARBITRATE', 'HANDOFF', 'GATE_FAIL']);
const byteLength = value => Buffer.byteLength(value, 'utf8');
const ABSORBED_MESSAGES = Symbol('absorbed receipt records');
const physicalMessages = messages => messages.flatMap(message => message[ABSORBED_MESSAGES] ?? [message]);

/** Clip only metadata; message content is either complete or an explicit reference. */
function metadata(text, maxBytes = 1200) {
  text = String(text ?? '');
  if (byteLength(text) <= maxBytes) return text;
  return Buffer.from(text).subarray(0, maxBytes - 80).toString('utf8').replace(/\uFFFD$/u, '')
    + '… [metadata shortened; read pair_status]';
}

export function urgentMail(message) {
  const decoded = decodeMessage(message.content);
  return CONTROL.has(decoded?.type) || ['P0', 'P1'].includes(decoded?.body?.severity);
}

/** Ordered admission, with one ordinary slot even during a control burst. */
export function selectDeliveryMessages(unread, team = {}) {
  const { absorbed, collapsed, live } = collapseUnread(unread, team);
  const control = live.filter(urgentMail), ordinary = live.filter(message => !urgentMail(message));
  if (absorbed.length > 0) {
    // Insert at the first absorbed receipt's ordinary-mail position, retaining
    // FIFO fairness for older unabsorbed mail as well as the control reserve.
    const first = unread.indexOf(absorbed[0]);
    const preceding = new Set(unread.slice(0, first));
    const slot = ordinary.findIndex(message => !preceding.has(message));
    ordinary.splice(slot < 0 ? ordinary.length : slot, 0, { content: collapsed[0], [ABSORBED_MESSAGES]: absorbed });
  }
  const picked = control.slice(0, DELIVERY_MAX_MESSAGES - (ordinary.length > 0 ? 1 : 0));
  return [...picked, ...ordinary.slice(0, DELIVERY_MAX_MESSAGES - picked.length)];
}

function reference(message) {
  return `[PAIR:MAIL_REFERENCE] message_id=${JSON.stringify(message.id)}; ${message.content.length} UTF-16 chars, ${byteLength(message.content)} UTF-8 bytes. Full durable content: pair_mailbox_read(message_id=${JSON.stringify(message.id)}, offset=0, max_chars=4000). Follow next_offset until complete; this reference is not the message body.`;
}

/** Build selected records only. Excess messages never enter this prompt. */
export function boundedMailboxPrompt(messages, team, recipient, config = {}, pending = messages.length) {
  const physicalCount = physicalMessages(messages).length;
  const owed = nextObligation(team, recipient, { oracleFirst: config.oracleFirst });
  const next = owed === undefined
    ? '[PAIR:NEXT] You have no owed action on the current board. Read pair_status before acting on older mail.'
    : metadata(obligationLine(owed, recipient), 2200);
  const header = 'Pair-programming durable mail. Host acceptance acknowledges notification only, not reading or completion. Use pair_* tools for state; never edit team.json or inbox files. CURRENT board outranks older mail.';
  const footer = `${next}\nSelected ${messages.length} logical notifications covering ${physicalCount} physical records; backlog ${Math.max(0, pending - physicalCount)} physical records. Limit: ${DELIVERY_MAX_MESSAGES} logical messages / ${DELIVERY_MAX_BYTES} UTF-8 bytes including metadata. Read pair_status first; assignments require pair_task_claim and current attempt_id.`;
  // Per-record allowance reserves room for every selected record, including an
  // ordinary record under a large urgent burst. The total is checked below.
  const allowance = Math.floor((DELIVERY_MAX_BYTES - byteLength(header + '\n\n' + footer) - messages.length * 2) / Math.max(1, messages.length));
  const records = messages.map(message => {
    if (message[ABSORBED_MESSAGES] !== undefined) return message.content;
    const prefix = `Message ${JSON.stringify(message.id)} from ${metadata(message.from, 160)}:\n`;
    const content = withoutLegacyNext(message.content);
    const full = prefix + content;
    return byteLength(full) <= allowance ? full : prefix + reference(message);
  });
  const text = [header, ...records, footer].join('\n\n');
  // IDs minted by createMessage are UUIDs. Refuse corrupt giant identity
  // metadata rather than emitting an oversized payload or losing a record.
  if (byteLength(text) > DELIVERY_MAX_BYTES) throw new Error('mail identity metadata exceeds delivery byte budget; inspect durable mailbox ids');
  return { text, bytes: byteLength(text), count: messages.length, physicalCount, backlog: Math.max(0, pending - physicalCount) };
}

/** Read board, select and lease atomically; no selected-but-unleased prompt. */
export async function prepareMailboxDelivery(stateRoot, teamId, recipient, config, { memberId, captainId, signal, urgentOnly = false } = {}) {
  return withLock(teamLockKey(stateRoot, teamId), async () => {
    if (signal?.aborted) return undefined;
    const team = await readTeam(stateRoot, teamId);
    if (team === undefined || isDispatchClosed(team.protocol.phase)) return undefined;
    if (captainId !== undefined && team.captainSessionId !== captainId) return undefined;
    if (recipient === 'captain' && memberId !== team.captainSessionId) return undefined;
    if (recipient !== 'captain' && !team.members.some(member => member.name === recipient && member.id === memberId && member.status !== 'removed')) return undefined;
    const unread = await readUnreadMailbox(stateRoot, teamId, recipient);
    if (urgentOnly && !unread.some(urgentMail)) return undefined;
    const selected = selectDeliveryMessages(unread, team);
    if (selected.length === 0) return undefined;
    const prompt = boundedMailboxPrompt(selected, team, recipient, config, unread.length);
    const records = physicalMessages(selected);
    const claim = await claimMailboxDelivery(stateRoot, teamId, recipient, records.map(message => message.id));
    if (claim.messageIds.length !== records.length) throw new Error('mailbox claim changed under team lock');
    return { ...prompt, ...claim, memberId, captainId: team.captainSessionId, recipient, teamId };
  });
}

/** A late admission for a stopped/recycled seat leaves mail retryable. */
export async function finishMailboxDelivery(stateRoot, delivery, accepted, signal) {
  return withLock(teamLockKey(stateRoot, delivery.teamId), async () => {
    const team = await readTeam(stateRoot, delivery.teamId);
    const current = team !== undefined && !isDispatchClosed(team.protocol.phase)
      && team.captainSessionId === delivery.captainId
      && (delivery.recipient === 'captain' || team.members.some(member => member.name === delivery.recipient && member.id === delivery.memberId && member.status !== 'removed'));
    const ok = accepted && current && !signal?.aborted;
    await (ok ? acknowledgeMailbox : releaseMailboxDelivery)(stateRoot, delivery.teamId, delivery.recipient, delivery.messageIds, delivery.claimId);
    return ok;
  });
}

// Shared by immediate and fallback delivery. Overlapping calls coalesce rather
// than allocating an unbounded tail of promises behind a hung host admission.
//
// Coalescing is right for a redundant duplicate and wrong for a WAKE. Measured
// (M16'): a durable delivery to an idle seat asked for its recovery kick while
// an earlier kick for the SAME seat was still mid-flight. The second request
// returned { busy: true } and was never run, so the seat stayed `idle` with
// `pending=1` in its mailbox and nothing ever re-read the board — the first
// flight had already decided, from a board read taken before that mail existed,
// that there was nothing to do. { busy: true } is invisible to the callers too,
// so no caller could compensate for it.
//
// A wake request is therefore DEFERRED, not dropped: the latest one replaces
// any earlier pending request (one re-run per arrival, never a queue) and runs
// after the flight that swallowed it, reading the board fresh. Requests only
// arrive from real events, so this cannot spin on its own, and a re-run that
// finds the mailbox drained or the seat mid-turn declines exactly as the first
// one would — which is what keeps repeated nudges at one model turn per board
// revision.
const FLIGHTS = new WeakMap(), TURNS = new WeakMap();
export async function coalesceDelivery(ctx, key, operation, { defer = false } = {}) {
  let flights = FLIGHTS.get(ctx);
  if (flights === undefined) { flights = new Map(); FLIGHTS.set(ctx, flights); }
  const inFlight = flights.get(key);
  if (inFlight !== undefined) {
    if (defer) inFlight.pending = operation;
    return { busy: true, deferred: defer };
  }
  const token = { pending: undefined };
  flights.set(key, token);
  try {
    let result = await operation();
    while (token.pending !== undefined) {
      const next = token.pending;
      token.pending = undefined;
      result = await next();
    }
    return result;
  } finally { if (flights.get(key) === token) flights.delete(key); }
}
export const deliveryKey = (stateRoot, teamId, recipient, memberId) => `${stateRoot}\0${teamId}\0${recipient}\0${memberId}`;

/**
 * A WAKE, as opposed to a redundant duplicate: the same coalescing, but the
 * request survives the flight instead of being discarded by it (M16' — the seat
 * that stayed idle with pending=1 because the wake asked for during an in-flight
 * kick was thrown away). See coalesceDelivery for why one re-run is enough.
 */
export const coalesceWake = (ctx, key, operation) => coalesceDelivery(ctx, key, operation, { defer: true });

/** Observe the edge synchronously, before any asynchronous board lookup.
 * Weak agent keys retain neither historical seat ids nor unrelated agents. */
export function observeDeliveryStatus(agent, status = agent?.status) {
  if (agent === undefined) return undefined;
  let turn = TURNS.get(agent);
  if (turn === undefined || turn.status !== status) {
    turn = { status, notified: false };
    TURNS.set(agent, turn);
  }
  return turn;
}
export function busyNotificationAllowed(turn) {
  return turn === undefined || turn.status === 'idle' || !turn.notified;
}
export function markBusyNotification(agent, turn) {
  if (turn !== undefined && turn.status !== 'idle' && TURNS.get(agent) === turn) turn.notified = true;
}
export function releaseDeliverySeats(ctx, seatIds, teamId) {
  const ids = new Set(seatIds);
  const flights = FLIGHTS.get(ctx);
  for (const key of flights?.keys() ?? []) {
    const [, team, , memberId] = key.split('\0');
    if (ids.has(memberId) || teamId === team) flights.delete(key);
  }
}