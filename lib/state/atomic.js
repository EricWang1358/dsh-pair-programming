/**
 * Windows-tolerant atomic file replacement.
 *
 * Adapted from @nanmicoder/dsh-agent-teams `lib/state.js` (MIT) —
 * `replaceFileAtomicOrDirect` and `atomicWriteText`. On Windows,
 * `rename(tmp, file)` over an existing target throws EPERM while any other
 * process keeps the target open without FILE_SHARE_DELETE (editors, indexers,
 * antivirus scans). Retry briefly, then fail without overwriting the last
 * committed state. Keep the complete temp file for explicit recovery; readers
 * must never see a truncated canonical file. Recovery is not automatic.
 *
 * @module dsh-pair-programming/state/atomic
 */
import { rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

/** Additional rename attempts before reporting a persistence failure. */
const ATOMIC_RENAME_RETRIES = 3;
/** Pause between rename attempts, giving a briefly-locking owner time to finish. */
const ATOMIC_RENAME_RETRY_DELAY_MS = 50;

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
      return;
    } catch (error) {
      if (isRetryableRenameError(error) && attempt < retries) {
        await sleep(retryDelayMs);
        continue;
      }
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
