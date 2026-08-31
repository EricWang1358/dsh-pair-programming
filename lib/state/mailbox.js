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
import { mkdir, readFile } from 'node:fs/promises';
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
 * Append one message to an agent's mailbox (JSONL).
 * Callers serialize with the team lock.
 */
export async function appendMailbox(stateRoot, teamId, agentKey, message) {
  const file = mailboxFile(stateRoot, teamId, agentKey);
  await mkdir(join(stateRoot, teamId, 'inbox'), { recursive: true });
  let existing = '';
  try {
    existing = await readFile(file, 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  const separator = existing !== '' && !existing.endsWith('\n') ? '\n' : '';
  await atomicWriteText(file, `${existing}${separator}${JSON.stringify(message)}\n`);
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
