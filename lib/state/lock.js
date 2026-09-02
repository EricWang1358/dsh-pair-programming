/**
 * Per-key serial mutation queues and path-safe key folding.
 *
 * Adapted from @nanmicoder/dsh-agent-teams `lib/state.js` (MIT) —
 * `withTeamLock` and `sanitizeKey` — generalized to any lock key.
 *
 * @module dsh-pair-programming/state/lock
 */
import { createHash } from 'node:crypto';

/** In-process per-key mutation queues (promise chains). */
const locks = new Map();

/**
 * Serialize mutations of one key across the whole process.
 * @param {string} key - the mutation scope (team id, cache namespace, ...).
 * @param {() => Promise<T>} fn - the mutation to run exclusively.
 * @returns {Promise<T>} the mutation's result.
 * @template T
 */
export async function withLock(key, fn) {
  const previous = locks.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // Capture THIS invoker's chain tail: the finally below may only retire the
  // chain it installed itself. Deleting by mere presence (M14' RC-1) also
  // dropped the next waiter's chain, letting a later arrival bypass a still
  // running critical section. Same identity guard as scheduler serializeMember.
  const tail = previous.then(() => gate);
  locks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) {
      // Best-effort cleanup of fully-drained chains to bound the map.
      locks.delete(key);
    }
  }
}

/** Longest key emitted before truncating and appending a digest. */
const MAX_KEY_LENGTH = 48;

/** Short stable digest, used to keep otherwise-colliding keys distinct. */
function keyDigest(name) {
  return createHash('sha256').update(name).digest('hex').slice(0, 8);
}

/**
 * Fold a free-form name into a safe path/key segment.
 *
 * Unicode letters and digits survive, so CJK/Cyrillic/Greek names stay
 * distinct and readable; everything else folds to `-`. A name with no letters
 * or digits at all gets a digest rather than a shared constant. Over-long
 * names are truncated with a digest appended, so names sharing a long prefix
 * stay distinct and the result stays within filesystem limits.
 *
 * @param {string} name - any user-supplied name.
 * @returns {string} a non-empty key safe as a single path segment.
 */
export function sanitizeKey(name) {
  const cleaned = name.normalize('NFC').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  if (cleaned === '') return `k-${keyDigest(name)}`;
  const points = [...cleaned];
  if (points.length > MAX_KEY_LENGTH) {
    return `${points.slice(0, MAX_KEY_LENGTH).join('')}-${keyDigest(name)}`;
  }
  return cleaned;
}
