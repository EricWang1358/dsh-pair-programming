/**
 * Windows-tolerant atomic file replacement.
 *
 * Adapted from @nanmicoder/dsh-agent-teams `lib/state.js` (MIT) —
 * `replaceFileAtomicOrDirect` and `atomicWriteText`. On Windows,
 * `rename(tmp, file)` over an existing target throws EPERM while any other
 * process keeps the target open without FILE_SHARE_DELETE (editors, indexers,
 * antivirus scans). By that point the payload is already fully written to the
 * temp file, so a direct overwrite of the target is a content-equivalent
 * degraded path: retry the rename a few times, then write the target in
 * place. Every path removes the temp file.
 *
 * @module dsh-pair-programming/state/atomic
 */
import { rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

/** Rename attempts before falling back to a direct overwrite. */
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
 * Replace `file` with `content`, preferring an atomic same-directory rename of
 * an already-written temp file, degrading to a direct overwrite when the
 * rename cannot proceed (see module doc for the Windows EPERM rationale).
 *
 * @param {string} temporary - the already-written temp file.
 * @param {string} file - the final target path.
 * @param {string} content - the payload (used for the direct-write fallback).
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
      let fallbackError;
      try {
        await primitives.writeFile(file, content);
      } catch (writeError) {
        fallbackError = writeError;
      }
      await primitives.remove(temporary).catch(() => undefined);
      if (fallbackError !== undefined) {
        throw new AggregateError(
          [error, fallbackError],
          `failed to replace "${file}" atomically (${String(error)}) or by direct write (${String(fallbackError)})`,
        );
      }
      return;
    }
  }
}

/**
 * Atomically replace one UTF-8 state file from a same-directory temp file,
 * degrading to a direct overwrite when the atomic rename cannot proceed.
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
