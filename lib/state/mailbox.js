/**
 * JSONL mailbox: one append-only mailbox per agent (captain or a member),
 * mirroring the Claude Code AgentTeams mailbox layout.
 *
 * Adapted from @nanmicoder/dsh-agent-teams `lib/state.js` (MIT) — the mailbox
 * portion: appendMailbox / readMailbox / readUnreadMailbox /
 * claimMailboxDelivery / releaseMailboxDelivery / acknowledgeMailbox.
 *
 * Messages are the durable truth; live delivery (subagent followup / captain
 * steer) is best-effort on top. A crashed live-delivery attempt becomes
 * retryable after MAILBOX_DELIVERY_LEASE_MS.
 *
 * @module dsh-pair-programming/state/mailbox
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteText, stripLeadingBom } from './atomic.js';
import { sanitizeKey } from './lock.js';

/** Mailbox key of the captain. */
export const CAPTAIN_KEY = 'captain';

/** A crashed live-delivery attempt becomes retryable after this interval. */
const MAILBOX_DELIVERY_LEASE_MS = 60_000;

function mailboxFile(stateRoot, teamId, agentKey) {
  return join(stateRoot, teamId, 'inbox', `${sanitizeKey(agentKey)}.jsonl`);
}

/** Build a fresh message record. */
export function createMessage(from, to, content) {
  return { id: randomUUID(), from, to, content, ts: Date.now() };
}

/**
 * Whether the mailbox ends on a record boundary, read one byte at a time.
 *
 * A missing file and an empty file both count: there is nothing to glue to.
 * Anything else means the previous append was interrupted mid-line, and the
 * next record must start on a line of its own rather than fusing with it.
 */
async function endsOnRecordBoundary(file) {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return true;
    const tail = Buffer.alloc(1);
    await handle.read(tail, 0, 1, size - 1);
    return tail[0] === 0x0A;
  } finally {
    await handle.close();
  }
}

/**
 * Append one message to an agent's mailbox (JSONL).
 * Callers serialize with the team lock.
 *
 * This is an O(1) append, not a read-and-rewrite. The rewrite was measured
 * (docs/diagnostics/2026-09-05-bench.mjs) at 1.2 ms to read a 160 KiB mailbox
 * plus 3.5 ms to commit it atomically, against 1.5 ms for a plain append, and
 * it rewrote 81 MiB of disk to deliver 1000 messages. Compacting the file
 * would only have shrunk the smaller of those two terms.
 *
 * What the atomic rewrite bought was a file that never carries a torn line.
 * It did NOT buy message durability: a crash before the rename lost the new
 * record exactly as a crash mid-append does, because in both cases the message
 * never reached disk whole. So the cost of this change is a torn TRAILING
 * line surviving in the file — which `readMailbox` already skips, and which
 * the boundary check above refuses to fuse the next record onto. Records
 * already committed are never rewritten, so an interrupted append can no
 * longer damage them; under the old path every append rewrote the whole
 * history and put all of it at risk.
 *
 * `mutateMailbox` (claim / release / acknowledge) still rewrites atomically:
 * it edits records in place, which an append cannot express.
 */
export async function appendMailbox(stateRoot, teamId, agentKey, message) {
  const file = mailboxFile(stateRoot, teamId, agentKey);
  await mkdir(join(stateRoot, teamId, 'inbox'), { recursive: true });
  const separator = (await endsOnRecordBoundary(file)) ? '' : '\n';
  await appendFile(file, `${separator}${JSON.stringify(message)}\n`, 'utf8');
}

/**
 * Read one agent's whole mailbox, oldest first. Malformed records are skipped
 * (one manually damaged line cannot make the whole mailbox unreadable).
 */
export async function readMailbox(stateRoot, teamId, agentKey, onMalformedLine) {
  const file = mailboxFile(stateRoot, teamId, agentKey);
  try {
    const raw = await readFile(file, 'utf8');
    const messages = [];
    for (const [index, rawLine] of raw.split('\n').entries()) {
      const line = stripLeadingBom(rawLine);
      if (line.trim() === '') continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        onMalformedLine?.(index + 1, new Error('invalid JSON'));
        continue;
      }
      if (!isTeamMessage(value)) {
        onMalformedLine?.(index + 1, new Error('invalid message shape'));
        continue;
      }
      messages.push(value);
    }
    return messages;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/** Read only messages not yet acknowledged by their recipient. */
export async function readUnreadMailbox(stateRoot, teamId, agentKey, onMalformedLine) {
  const now = Date.now();
  return (await readMailbox(stateRoot, teamId, agentKey, onMalformedLine))
    .filter(message => message.readAt === undefined
      && (message.deliveryClaimedAt === undefined
        || now - message.deliveryClaimedAt >= MAILBOX_DELIVERY_LEASE_MS));
}

async function mutateMailbox(stateRoot, teamId, agentKey, messageIds, mutate) {
  if (messageIds.length === 0) return;
  const file = mailboxFile(stateRoot, teamId, agentKey);
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  const selected = new Set(messageIds);
  const lines = raw.split('\n').map((rawLine) => {
    const line = stripLeadingBom(rawLine);
    if (line.trim() === '') return rawLine;
    try {
      const value = JSON.parse(line);
      if (!isTeamMessage(value) || !selected.has(value.id)) return rawLine;
      return JSON.stringify(mutate(value));
    } catch {
      return rawLine;
    }
  });
  await atomicWriteText(file, lines.join('\n'));
}

/** Lease selected fallback messages to one delivery path. */
export async function claimMailboxDelivery(stateRoot, teamId, agentKey, messageIds) {
  const now = Date.now();
  await mutateMailbox(stateRoot, teamId, agentKey, messageIds, message => ({
    ...message,
    deliveryClaimedAt: now,
  }));
}

/** Release a failed delivery lease so the scheduler can retry it later. */
export async function releaseMailboxDelivery(stateRoot, teamId, agentKey, messageIds) {
  await mutateMailbox(stateRoot, teamId, agentKey, messageIds, (message) => {
    const { deliveryClaimedAt: _claimed, ...released } = message;
    return released;
  });
}

/**
 * Mark selected durable mailbox records delivered/read while preserving
 * malformed lines for diagnostics. Callers serialize this with the team lock.
 */
export async function acknowledgeMailbox(stateRoot, teamId, agentKey, messageIds) {
  const now = Date.now();
  await mutateMailbox(stateRoot, teamId, agentKey, messageIds, (message) => {
    const { deliveryClaimedAt: _claimed, ...rest } = message;
    return {
      ...rest,
      deliveredAt: message.deliveredAt ?? now,
      readAt: message.readAt ?? now,
    };
  });
}

/** Mark every not-yet-read record discarded and return the count. */
export async function discardUnreadMailbox(stateRoot, teamId, agentKey) {
  const unread = (await readMailbox(stateRoot, teamId, agentKey)).filter(message => message.readAt === undefined);
  await acknowledgeMailbox(stateRoot, teamId, agentKey, unread.map(message => message.id));
  return unread.length;
}

/** Whether a value is a plain record. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate one message at the durable JSONL boundary. */
function isTeamMessage(value) {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['from'] === 'string'
    && typeof value['to'] === 'string'
    && typeof value['content'] === 'string'
    && typeof value['ts'] === 'number' && Number.isFinite(value['ts']);
}
