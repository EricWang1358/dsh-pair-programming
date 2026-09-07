/**
 * One durable notification batch: at most 8 records and 16 KiB UTF-8 INCLUDING
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
export function selectDeliveryMessages(unread) {
  const control = unread.filter(urgentMail), ordinary = unread.filter(message => !urgentMail(message));
  const picked = control.slice(0, DELIVERY_MAX_MESSAGES - (ordinary.length > 0 ? 1 : 0));
  return [...picked, ...ordinary.slice(0, DELIVERY_MAX_MESSAGES - picked.length)];
}

function reference(message) {
  return `[PAIR:MAIL_REFERENCE] message_id=${JSON.stringify(message.id)}; ${message.content.length} UTF-16 chars, ${byteLength(message.content)} UTF-8 bytes. Full durable content: pair_mailbox_read(message_id=${JSON.stringify(message.id)}, offset=0, max_chars=4000). Follow next_offset until complete; this reference is not the message body.`;
}

/** Build selected records only. Excess messages never enter this prompt. */
export function boundedMailboxPrompt(messages, team, recipient, config = {}, pending = messages.length) {
  const owed = nextObligation(team, recipient, { oracleFirst: config.oracleFirst });
  const next = owed === undefined
    ? '[PAIR:NEXT] You have no owed action on the current board. Read pair_status before acting on older mail.'
    : metadata(obligationLine(owed, recipient), 2200);
  const header = 'Pair-programming durable mail. Host acceptance acknowledges notification only, not reading or completion. Use pair_* tools for state; never edit team.json or inbox files. CURRENT board outranks older mail.';
  const footer = `${next}\nSelected ${messages.length}; backlog ${Math.max(0, pending - messages.length)}. Limit: ${DELIVERY_MAX_MESSAGES} messages / ${DELIVERY_MAX_BYTES} UTF-8 bytes including metadata. Read pair_status first; assignments require pair_task_claim and current attempt_id.`;
  // Per-record allowance reserves room for every selected record, including an
  // ordinary record under a large urgent burst. The total is checked below.
  const allowance = Math.floor((DELIVERY_MAX_BYTES - byteLength(header + '\n\n' + footer) - messages.length * 2) / Math.max(1, messages.length));
  const records = messages.map(message => {
    const { collapsed } = urgentMail(message) ? { collapsed: [] } : collapseUnread([message], team);
    const prefix = `Message ${JSON.stringify(message.id)} from ${metadata(message.from, 160)}:\n`;
    const content = collapsed[0] ?? withoutLegacyNext(message.content);
    const full = prefix + content;
    return byteLength(full) <= allowance ? full : prefix + reference(message);
  });
  const text = [header, ...records, footer].join('\n\n');
  // IDs minted by createMessage are UUIDs. Refuse corrupt giant identity
  // metadata rather than emitting an oversized payload or losing a record.
  if (byteLength(text) > DELIVERY_MAX_BYTES) throw new Error('mail identity metadata exceeds delivery byte budget; inspect durable mailbox ids');
  return { text, bytes: byteLength(text), count: messages.length, backlog: Math.max(0, pending - messages.length) };
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
    const selected = selectDeliveryMessages(unread);
    if (selected.length === 0) return undefined;
    const prompt = boundedMailboxPrompt(selected, team, recipient, config, unread.length);
    const claim = await claimMailboxDelivery(stateRoot, teamId, recipient, selected.map(message => message.id));
    if (claim.messageIds.length !== selected.length) throw new Error('mailbox claim changed under team lock');
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
const FLIGHTS = new WeakMap(), BUSY_NOTIFIED = new WeakMap();
export async function coalesceDelivery(ctx, key, operation) {
  let flights = FLIGHTS.get(ctx);
  if (flights === undefined) { flights = new Set(); FLIGHTS.set(ctx, flights); }
  if (flights.has(key)) return { busy: true };
  flights.add(key);
  try { return await operation(); } finally { flights.delete(key); }
}
export const deliveryKey = (stateRoot, teamId, recipient) => `${stateRoot}\0${teamId}\0${recipient}`;

/** At most one urgent host-inbox admission per running turn. */
export function busyNotificationAllowed(ctx, key, memberId, busy) {
  let seen = BUSY_NOTIFIED.get(ctx);
  if (seen === undefined) { seen = new Map(); BUSY_NOTIFIED.set(ctx, seen); }
  if (!busy) { seen.delete(key); return true; }
  return seen.get(key) !== memberId;
}
export function markBusyNotification(ctx, key, memberId) {
  BUSY_NOTIFIED.get(ctx)?.set(key, memberId);
}
export function releaseDeliverySeats(ctx, seatIds, teamId) {
  const seen = BUSY_NOTIFIED.get(ctx);
  if (seen === undefined) return;
  const ids = new Set(seatIds);
  for (const [key, id] of seen) if (ids.has(id) || (teamId !== undefined && key.split('\0')[1] === teamId)) seen.delete(key);
}
