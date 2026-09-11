/**
 * The runtime-input seed must stay inside the workspace it copies from, and inside
 * the checkout it copies into, even when an ANCESTOR of a declared path is a link.
 *
 * Why this suite exists (plan section J1, measured): the first version of the seed
 * checked the FINAL node with lstat and tested containment LEXICALLY. Both still pass
 * when an ancestor is a junction, so declaring \`data/input.json\` while
 * \`workspace/data\` pointed outside the workspace copied the external file in, and a
 * \`worktree/local\` pointing outside let the copy create its file outside the checkout.
 * That is a read and a write beyond the boundary the function exists to hold, in the
 * one path whose whole job is to decide what crosses into a tree nobody reviewed.
 *
 * Every case drives the real \`seedRuntimeInputs\` against temp directories only, with
 * no model call, no git subprocess and no host SDK. Links are created as junctions
 * (a Windows host cannot always create file symlinks) and each one is RELEASED before
 * its tree is removed: a recursive delete would follow it, which is the same hazard
 * the seed itself is being fixed for.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, symlinkSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedRuntimeInputs } from '../lib/runtime/worktrees.js';

/** Links this suite made, released explicitly before any tree is removed. */
const links = [];
function linkDir(target, path) {
  try { symlinkSync(target, path, 'junction'); }
  catch { symlinkSync(target, path, 'dir'); }
  links.push(path);
}
function linkFile(target, path) {
  symlinkSync(target, path, 'file');
  links.push(path);
}
function releaseLinks() {
  while (links.length > 0) {
    const path = links.pop();
    try { if (lstatSync(path).isSymbolicLink()) unlinkSync(path); } catch { /* already gone */ }
  }
}
/** Two directories that can each be reached directly and through a link. */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'pair-seed-boundary-'));
  const workspace = join(root, 'workspace');
  const worktree = join(root, 'worktree');
  const outside = join(root, 'outside');
  for (const dir of [workspace, worktree, outside]) mkdirSync(dir, { recursive: true });
  return { root, workspace, worktree, outside };
}

export async function run(check) {
  const roots = [];
  const scenario = (name, fn) => {
    const dirs = scratch();
    roots.push(dirs.root);
    try {
      const result = fn(dirs);
      check(true, name);
      return result;
    } catch (error) {
      check(false, name + ': ' + String(error?.message ?? error));
      return undefined;
    } finally {
      releaseLinks();
    }
  };

  try {
    // ---- 1. a SOURCE ancestor that is a link must not let external bytes in ----
    scenario('J1 a declared path whose SOURCE ancestor is a junction seeds nothing', dirs => {
      writeFileSync(join(dirs.outside, 'input.json'), '{"secret":"outside"}\n');
      linkDir(dirs.outside, join(dirs.workspace, 'data'));
      const report = seedRuntimeInputs(dirs.workspace, dirs.worktree, ['data/input.json']);
      assert.equal(report.seeded.length, 0, 'an ancestor link was followed and external content was seeded');
      assert.equal(existsSync(join(dirs.worktree, 'data', 'input.json')), false, 'external content reached the checkout');
      assert.match(report.skipped[0].reason, /link/i, 'the refusal must name the link');
    });

    // ---- 2. a TARGET ancestor that is a link must not be written through ------
    scenario('J1 a declared path whose TARGET ancestor is a junction writes nothing', dirs => {
      mkdirSync(join(dirs.workspace, 'local'), { recursive: true });
      writeFileSync(join(dirs.workspace, 'local', 'new.json'), '{"from":"workspace"}\n');
      linkDir(dirs.outside, join(dirs.worktree, 'local'));
      const report = seedRuntimeInputs(dirs.workspace, dirs.worktree, ['local/new.json']);
      assert.equal(report.seeded.length, 0, 'a target ancestor link was written through');
      assert.equal(existsSync(join(dirs.outside, 'new.json')), false, 'a file was created outside the checkout');
    });

    // ---- 3. a nested link deeper on the source path ---------------------------
    scenario('J1 a NESTED source junction is refused too', dirs => {
      writeFileSync(join(dirs.outside, 'c.json'), '{"secret":"nested"}\n');
      mkdirSync(join(dirs.workspace, 'a'), { recursive: true });
      linkDir(dirs.outside, join(dirs.workspace, 'a', 'b'));
      const report = seedRuntimeInputs(dirs.workspace, dirs.worktree, ['a/b/c.json']);
      assert.equal(report.seeded.length, 0, 'a nested ancestor link was followed');
      assert.equal(existsSync(join(dirs.worktree, 'a', 'b', 'c.json')), false);
    });

    // ---- 4. the leaf itself as a direct link ----------------------------------
    scenario('J1 a direct file link is refused at the leaf', dirs => {
      writeFileSync(join(dirs.outside, 'real.json'), '{"secret":"leaf"}\n');
      try { linkFile(join(dirs.outside, 'real.json'), join(dirs.workspace, 'link.json')); }
      catch { return; } // a host without symlink privilege: the leaf case is covered by the ancestor cases
      const report = seedRuntimeInputs(dirs.workspace, dirs.worktree, ['link.json']);
      assert.equal(report.seeded.length, 0, 'a leaf link was copied');
      assert.equal(existsSync(join(dirs.worktree, 'link.json')), false);
    });

    // P2 (reviewer, HEAD 9a0ca54): a declared file AT the checkout root has the root as
    // its parent directory, and the strict containment reading refused it - seeded [] plus
    // a misleading 'resolves outside the disposable checkout'.
    scenario('P2 a declared file at the checkout root is seeded, not refused', dirs => {
      writeFileSync(join(dirs.workspace, 'runtime.json'), '{"pool":"canonical"}\n');
      const report = seedRuntimeInputs(dirs.workspace, dirs.worktree, ['runtime.json']);
      assert.deepEqual(report.seeded, ['runtime.json']);
      assert.equal(readFileSync(join(dirs.worktree, 'runtime.json'), 'utf8'), '{"pool":"canonical"}\n');
    });
    // ---- 5. the ordinary path still works -------------------------------------
    scenario('J1 a normal declared path is still seeded, as a copy', dirs => {
      mkdirSync(join(dirs.workspace, 'data'), { recursive: true });
      writeFileSync(join(dirs.workspace, 'data', 'jobs.json'), '{"pool":"canonical"}\n');
      const report = seedRuntimeInputs(dirs.workspace, dirs.worktree, ['data/jobs.json']);
      assert.deepEqual(report.seeded, ['data/jobs.json']);
      assert.equal(readFileSync(join(dirs.worktree, 'data', 'jobs.json'), 'utf8'), '{"pool":"canonical"}\n');
      assert.equal(lstatSync(join(dirs.worktree, 'data', 'jobs.json')).isSymbolicLink(), false, 'the seed must be a copy, never a link');
    });

    // ---- 6. the candidate still wins ------------------------------------------
    scenario('J1 a file the merged tree already carries is never overwritten', dirs => {
      mkdirSync(join(dirs.workspace, 'data'), { recursive: true });
      writeFileSync(join(dirs.workspace, 'data', 'jobs.json'), '{"pool":"canonical"}\n');
      mkdirSync(join(dirs.worktree, 'data'), { recursive: true });
      writeFileSync(join(dirs.worktree, 'data', 'jobs.json'), '{"pool":"candidate"}\n');
      const report = seedRuntimeInputs(dirs.workspace, dirs.worktree, ['data/jobs.json']);
      assert.deepEqual(report.seeded, []);
      assert.equal(readFileSync(join(dirs.worktree, 'data', 'jobs.json'), 'utf8'), '{"pool":"candidate"}\n');
    });

    // ---- 7. a missing declaration is reported, never invented ------------------
    scenario('J1 a declared input with a missing directory is reported, not created', dirs => {
      const report = seedRuntimeInputs(dirs.workspace, dirs.worktree, ['nope/jobs.json']);
      assert.deepEqual(report.missing, ['nope/jobs.json']);
      assert.equal(report.seeded.length, 0);
      assert.equal(existsSync(join(dirs.worktree, 'nope')), false, 'the seed created a directory for a declaration it could not fill');
    });
  } finally {
    releaseLinks();
    for (const root of roots.splice(0)) {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}
