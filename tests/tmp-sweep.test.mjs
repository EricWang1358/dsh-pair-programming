/** #103: the sweep removes only OUR stale fixtures, by prefix AND age. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepStaleFixtures, isFixtureDir, FIXTURE_PREFIXES } from './support/tmp-sweep.mjs';

const OLD = new Date(Date.now() - 48 * 60 * 60 * 1000);

export async function run(check) {
  const root = await mkdtemp(join(tmpdir(), 'pair-sweep-'));
  try {
    await mkdir(join(root, 'pair-integrate-stale'));
    await utimes(join(root, 'pair-integrate-stale'), OLD, OLD);
    await mkdir(join(root, 'pair-backlog-fresh'));
    await mkdir(join(root, 'somebody-elses-dir'));
    await utimes(join(root, 'somebody-elses-dir'), OLD, OLD);
    await mkdir(join(root, 'pair-not-ours-'));
    await utimes(join(root, 'pair-not-ours-'), OLD, OLD);
    const result = await sweepStaleFixtures({ tmp: root });
    check(result.removed.length === 1 && result.removed[0] === 'pair-integrate-stale',
      'an old directory with one of our prefixes is removed');
    check(!existsSync(join(root, 'pair-integrate-stale')), 'and it is really gone');
    check(existsSync(join(root, 'pair-backlog-fresh')), 'a RECENT fixture directory is spared - a live run may own it');
    check(existsSync(join(root, 'somebody-elses-dir')), 'a directory that is not ours is never touched, however old');
    check(existsSync(join(root, 'pair-not-ours-')), 'and neither is a pair-* directory we do not recognise');
    check(result.kept.some(entry => entry.reason.startsWith('recent')), 'the result says WHY something was spared');
    check(FIXTURE_PREFIXES.every(prefix => prefix.endsWith('-')) && isFixtureDir('pair-cleanup-x') && isFixtureDir('pair-panel-x') && !isFixtureDir('pair-x'),
      'the prefix list is closed: every entry ends with a dash, so a one-off name is not swept by accident');
  } finally { await rm(root, { recursive: true, force: true }); }
  check(true, 'sweep scope: ' + FIXTURE_PREFIXES.length + ' prefixes, age-filtered');
}