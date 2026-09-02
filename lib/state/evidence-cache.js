/**
 * L2 repository evidence cache.
 *
 * Key = sha256(scope + gitHead + subject), so entries invalidate precisely
 * when the repository head or the subject (file mtime / command) changes —
 * no主动 cleanup needed. Single file per entry; the filesystem is the index.
 * LRU-trimmed to a cap to bound growth. Writes are atomic (state/atomic.js).
 *
 * Hits/misses feed the protocol stats surfaced in the retrospective report.
 *
 * @module dsh-pair-programming/state/evidence-cache
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteText, stripLeadingBom } from './atomic.js';
import { withLock } from './lock.js';
import { cacheDirOf } from './layout.js';

/** Maximum retained cache entries (LRU by mtime). */
const CACHE_CAP = 500;
const CACHE_LOCK = 'evidence-cache';

function cacheKey(...parts) {
  return createHash('sha256').update(parts.join('')).digest('hex');
}

export class EvidenceCache {
  /**
   * @param {string} stateRoot - resolved absolute state root.
   * @param {boolean} enabled - config switch.
   * @param {{cacheHits:number, cacheMiss:number}} stats - shared protocol stats bucket.
   * @param {(msg:string)=>void} [log]
   */
  constructor(stateRoot, enabled, stats, log) {
    this.dir = cacheDirOf(stateRoot);
    this.enabled = enabled;
    this.stats = stats;
    this.log = log ?? (() => undefined);
  }

  /**
   * Read the cached digest for one file, keyed by git head + path + mtime.
   * @returns {Promise<any|undefined>} the cached value, or undefined on miss.
   */
  async getFileDigest(gitHead, relPath, mtimeMs) {
    return this.#get('file', gitHead, relPath, String(mtimeMs));
  }

  /** Store the digest for one file. */
  async setFileDigest(gitHead, relPath, mtimeMs, value) {
    await this.#set(value, 'file', gitHead, relPath, String(mtimeMs));
  }

  /** Read the cached test baseline for one command at one git head. */
  async getTestBaseline(gitHead, cmd) {
    return this.#get('test', gitHead, cmd);
  }

  /** Store the test baseline for one command at one git head. */
  async setTestBaseline(gitHead, cmd, value) {
    await this.#set(value, 'test', gitHead, cmd);
  }

  /** Read the cached gate-command result for one command at one content digest. */
  async getGateResult(cmd, digest) { return this.#get('gate', cmd, digest); }

  /** Store the gate-command result for one command at one content digest. */
  async setGateResult(cmd, digest, value) { await this.#set(value, 'gate', cmd, digest); }

  async #get(scope, ...parts) {
    if (!this.enabled) return undefined;
    const key = cacheKey(scope, ...parts);
    try {
      const raw = await readFile(join(this.dir, `${key}.json`), 'utf8');
      this.stats.cacheHits += 1;
      return JSON.parse(stripLeadingBom(raw));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        this.stats.cacheMiss += 1;
        return undefined;
      }
      this.log(`evidence-cache: read ${key} failed: ${String(error)}`);
      this.stats.cacheMiss += 1;
      return undefined;
    }
  }

  async #set(value, scope, ...parts) {
    if (!this.enabled) return;
    const key = cacheKey(scope, ...parts);
    await withLock(CACHE_LOCK, async () => {
      try {
        await mkdir(this.dir, { recursive: true });
        await atomicWriteText(join(this.dir, `${key}.json`), JSON.stringify(value));
        await this.#trim();
      } catch (error) {
        this.log(`evidence-cache: write ${key} failed: ${String(error)}`);
      }
    });
  }

  /** Trim to CACHE_CAP entries by mtime (oldest first). Best effort. */
  async #trim() {
    let entries;
    try {
      entries = await readdir(this.dir);
    } catch {
      return;
    }
    if (entries.length <= CACHE_CAP) return;
    const withMtime = await Promise.all(entries.map(async (name) => {
      try {
        return { name, mtime: (await stat(join(this.dir, name))).mtimeMs };
      } catch {
        return { name, mtime: 0 };
      }
    }));
    withMtime.sort((a, b) => a.mtime - b.mtime);
    const excess = withMtime.slice(0, withMtime.length - CACHE_CAP);
    await Promise.all(excess.map(e => rm(join(this.dir, e.name), { force: true }).catch(() => undefined)));
  }
}
