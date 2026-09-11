/**
 * Stale fixture sweep (#103).
 *
 * Every fixture mkdtemps its own directory and removes it in a finally block, which is correct
 * until a run is interrupted - then the finally never runs and the directory stays forever.
 * Measured 2026-09-11: 361 pair-* directories in TEMP, all of them debris from interrupted runs.
 *
 * The rule that makes a sweep safe: it only touches directories whose name carries one of OUR
 * fixture prefixes, and only when they are older than a generous age (six hours by default).
 * Prefix plus age means a directory another process is using right now cannot match, and a
 * directory that belongs to anyone else cannot match at all.
 *
 * @module tests/support/tmp-sweep
 */
import { readdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The prefixes this project's fixtures use. A directory matching none of them is not ours. */
export const FIXTURE_PREFIXES = [
  'pair-integrate-', 'pair-worktrees-', 'pair-close-', 'pair-dual-settings-', 'pair-backlog-',
  'pair-cleanup-', 'pair-pause-matrix-', 'pair-kick-', 'pair-fp-', 'pair-cost-', 'pair-tests-',
  'pair-state-', 'pair-gate-', 'pair-flow-', 'pair-lifecycle-', 'pair-mail-', 'pair-oracle-',
  'pair-verify-', 'pair-scope-', 'pair-delivery-', 'pair-settings-', 'pair-isolated-',
  'pair-parallel-', 'pair-yield-', 'pair-risk-', 'pair-solo-', 'pair-product-', 'pair-repair-',
  'pair-panel-',   // the console/UI suite's fixtures
];

export const isFixtureDir = name => FIXTURE_PREFIXES.some(prefix => name.startsWith(prefix));

/**
 * Remove stale fixture directories under `tmp`. Returns what it removed and what it spared,
 * so a caller can print the numbers instead of asserting a clean room.
 */
export async function sweepStaleFixtures({ tmp = tmpdir(), maxAgeMs = 6 * 60 * 60 * 1000, now = Date.now() } = {}) {
  const removed = [], kept = [];
  let entries = [];
  try { entries = readdirSync(tmp); } catch { return { removed, kept, scanned: 0 }; }
  for (const name of entries) {
    if (!isFixtureDir(name)) continue;
    const path = join(tmp, name);
    try {
      const stats = statSync(path);
      if (!stats.isDirectory()) continue;
      if (now - stats.mtimeMs < maxAgeMs) { kept.push({ name, reason: 'recent - a live run may own it' }); continue; }
      await rm(path, { recursive: true, force: true });
      removed.push(name);
    } catch (error) { kept.push({ name, reason: 'unreadable: ' + String(error.message) }); }
  }
  return { removed, kept, scanned: entries.length };
}