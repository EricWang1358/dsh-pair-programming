/**
 * Windows-tolerant atomic file replacement.
 *
 * Adapted from @nanmicoder/dsh-agent-teams `lib/state.js` (MIT) —
 * `replaceFileAtomicOrDirect` and `atomicWriteText`. On Windows,
 * `rename(tmp, file)` over an existing target throws EPERM while any other
 * process keeps the target open without FILE_SHARE_DELETE (editors, indexers,
 * antivirus scans). Retry briefly, then fail without overwriting the last
 * committed state. Keep the complete temp file for explicit recovery; readers
 * must never see a truncated canonical file. Recovery is not automatic — a
 * recovery copy is removed only once a LATER commit of the same target has
 * succeeded, which is the point at which the version it holds is superseded
 * rather than merely old.
 *
 * @module dsh-pair-programming/state/atomic
 */
import { readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Additional rename attempts before reporting a persistence failure. */
const ATOMIC_RENAME_RETRIES = 3;
/** Pause between rename attempts, giving a briefly-locking owner time to finish. */
const ATOMIC_RENAME_RETRY_DELAY_MS = 50;

/**
 * A recovery copy stops being worth keeping once the target it was written for
 * has been committed successfully: it holds a version that never landed and
 * has since been superseded. Younger ones are left alone so this can never
 * race a write that is still in flight.
 */
const RECOVERY_COPY_STALE_MS = 60_000;

/**
 * Targets whose last commit failed and left a recovery copy behind.
 *
 * The sweep runs only for these, on their next successful commit. Scanning the
 * directory on every write would put a readdir on the hot path to bound a
 * condition that only arises after a loud, explicit failure — and 0.13.5 fixed
 * unbounded process-local growth, so this set is cleared as it is consumed.
 */
const targetsWithRecoveryCopies = new Set();

/**
 * Drop this process's superseded recovery copies for one target.
 *
 * Scoped to the target on purpose. A sibling file's recovery copy in the same
 * directory is NOT superseded by this commit, and deleting recovery material
 * that still describes an uncommitted write is the exact behaviour that made
 * the original defect destructive. Best effort throughout: failing to tidy up
 * must never fail a write that already succeeded.
 */
async function sweepSupersededRecoveryCopies(file) {
  const directory = dirname(file);
  const prefix = `${basename(file)}.${process.pid}.`;
  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  const cutoff = Date.now() - RECOVERY_COPY_STALE_MS;
  await Promise.all(entries
    .filter(name => name.startsWith(prefix) && name.endsWith('.tmp'))
    .map(async (name) => {
      const path = join(directory, name);
      try {
        if ((await stat(path)).mtimeMs > cutoff) return;
        await rm(path, { force: true });
      } catch { /* another writer got there first, or it is gone already */ }
    }));
}

/** Rename error codes worth retrying before the direct-write fallback. */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY']);

function isRetryableRenameError(error) {
  return error instanceof Error
    && 'code' in error
    && RETRYABLE_RENAME_CODES.has(error.code ?? '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Commit an already-written temp file by same-directory rename only.
 * The legacy export/signature is retained for callers; direct writes are
 * deliberately no longer used, even when rename cannot proceed.
 *
 * @param {string} temporary - the already-written temp file.
 * @param {string} file - the final target path.
 * @param {string} content - legacy argument, unused.
 * @param {{rename:Function, writeFile:Function, remove:Function}} primitives
 * @param {{retries?:number, retryDelayMs?:number}} [options]
 */
export async function replaceFileAtomicOrDirect(temporary, file, content, primitives, options = {}) {
  const retries = options.retries ?? ATOMIC_RENAME_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? ATOMIC_RENAME_RETRY_DELAY_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await primitives.rename(temporary, file);
      if (targetsWithRecoveryCopies.delete(file)) await sweepSupersededRecoveryCopies(file);
      return;
    } catch (error) {
      if (isRetryableRenameError(error) && attempt < retries) {
        await sleep(retryDelayMs);
        continue;
      }
      targetsWithRecoveryCopies.add(file);
      throw Object.assign(new Error(
        `could not commit "${file}"; previous state preserved, recovery copy at "${temporary}"`,
        { cause: error },
      ), { code: 'PAIR_STATE_COMMIT_FAILED', target: file, recoveryPath: temporary });
    }
  }
}

/**
 * Atomically replace one UTF-8 state file from a same-directory temp file,
 * preserving the previous state and complete temp file if rename fails.
 *
 * @param {string} file - the target path.
 * @param {string} content - the UTF-8 payload.
 */
export async function atomicWriteText(file, content) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await replaceFileAtomicOrDirect(temporary, file, content, {
    rename: (from, to) => rename(from, to),
    writeFile: (target, payload) => writeFile(target, payload, 'utf8'),
    remove: (path) => rm(path, { force: true }),
  });
}

/** Remove the optional UTF-8 BOM some editors prepend to JSON text. */
export function stripLeadingBom(value) {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}
