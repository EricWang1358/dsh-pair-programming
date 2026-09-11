/** Git-backed Driver isolation. Only verified integration trees reach the user's branch. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, unlink } from 'node:fs/promises';
import { copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, relative, join, dirname, basename, isAbsolute, sep } from 'node:path';
import { withLock } from '../state/lock.js';

const execute = promisify(execFile);
const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
const identity = ['-c', 'user.name=DSH Pair', '-c', 'user.email=dsh-pair@localhost', '-c', 'commit.gpgSign=false'];
// A Windows autocrlf=true checkout would rewrite sealed LF oracle bytes.
// Suppress implicit output conversion only for our checkouts; repository
// attributes remain authoritative and any resulting seal mismatch fails closed.
const checkout = ['-c', 'core.autocrlf=input'];
async function git(cwd, args, options = {}) {
  const result = await execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  return args.includes('-z') ? result.stdout : result.stdout.trim();
}
function contained(root, path) {
  const part = relative(root, path);
  return part !== '' && !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
}
export function pathName(value) {
  if (typeof value !== 'string' || !value || /[\0*?\[\]:]/u.test(value)) throw new Error('Scope paths must be literal relative paths');
  const path = value.replaceAll('\\', '/').replace(/\/$/u, '');
  if (!path || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Scope path must stay inside its workspace');
  return fold(path);
}
/** The runtime inputs a run declares for the disposable integration checkout.
 * The rules are pathName's — literal, relative and inside the workspace: no
 * absolute path, no `..`, no glob or drive characters — because this list is
 * copied into a checkout, and a declaration that can escape it is not one. */
export function runtimePathsOf(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('integration_runtime_paths must be an array of literal relative paths');
  return [...new Set(value.map(entry => {
    try { return pathName(entry); }
    catch (error) { throw new Error('integration_runtime_paths ' + JSON.stringify(entry) + ': ' + error.message); }
  }))];
}
const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const under = (file, prefix) => file === prefix || file.startsWith(`${prefix}/`);
const exclude = paths => paths.map(path => `:(top,exclude,literal)${path}`);
async function clean(workspace, ignored) {
  const status = await git(workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.', ...exclude(ignored)]);
  if (status) throw new Error('A clean Git workspace is required; preserve or commit user changes first');
}
async function head(workspace) { return git(workspace, ['rev-parse', '--verify', 'HEAD']); }
function commitId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value)) throw new Error('Candidate requires a full Git commit id');
  return value;
}
async function rootOf(workspace) {
  const root = await realpath(workspace);
  let repository;
  try { repository = await git(root, ['rev-parse', '--show-toplevel']); }
  catch (error) {
    if (/not a git repository/i.test(String(error.stderr))) throw checkpointRequired('This workspace is not a Git repository');
    throw error;
  }
  const gitRoot = await realpath(repository);
  if (fold(root) !== fold(gitRoot)) throw new Error('Parallel Drivers require the Git repository root as workspace');
  return root;
}
function checkOwner(parallel, path) {
  const teamPath = join(parallel.stateRoot, parallel.teamId, 'worktrees');
  if (!contained(parallel.workspace, parallel.stateRoot) || !contained(teamPath, resolve(path))) throw new Error('Refusing a worktree path outside the owned team directory');
}

function checkpointRequired(problem) {
  const error = new Error('PAIR_GIT_CHECKPOINT_REQUIRED: ' + problem
    + '. Captain: propose saving the current checkpoint as a LOCAL Git baseline for two isolated Drivers. '
    + 'Show the workspace, intended files, ignore rules for secrets/generated files, and the initial commit plan; ask the user for explicit approval before git init or staging/committing. '
    + 'Do not use git add -A blindly, publish a remote, reset, stash, or discard current work. If declined, offer drivers=1. '
    + 'After approval, create/reuse the local repository, commit the approved files, then retry pair_start with drivers=2 and the integration command. Existing teams need a recorded handoff and normal closure before a new team; do not erase cycles, bypass gates or abort merely to switch modes.');
  error.code = 'PAIR_GIT_CHECKPOINT_REQUIRED';
  return error;
}

/** Read-only prerequisite check, before a team or worktree is created. */
export async function requireDriverCheckpoint(workspace) {
  const root = await rootOf(workspace);
  try { await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']); }
  catch (error) {
    if (error.code === 1) throw checkpointRequired('This Git repository has no valid HEAD commit');
    throw error;
  }
  return root;
}

/** Each slot owns an ordinary branch, HEAD and index. No user files are staged. */
export async function createDriverWorktrees(workspace, stateRoot, teamId) {
  workspace = await requireDriverCheckpoint(workspace); stateRoot = resolve(stateRoot);
  if (!contained(workspace, stateRoot)) throw new Error('stateRoot must be inside the Git workspace');
  if (typeof teamId !== 'string' || !teamId || teamId === '.' || teamId === '..' || /[\\/\0:]/u.test(teamId)) throw new Error('Invalid team path segment');
  const stateRelative = relative(workspace, stateRoot).replaceAll('\\', '/');
  if (fold(stateRelative.split('/')[0]) === '.git') throw new Error('stateRoot cannot use Git metadata directories');
  await clean(workspace, [stateRelative]);
  const baseHead = await head(workspace);
  await mkdir(stateRoot, { recursive: true });
  if (!contained(workspace, await realpath(stateRoot))) throw new Error('stateRoot resolves outside the Git workspace');
  const worktrees = join(stateRoot, teamId, 'worktrees');
  await mkdir(worktrees, { recursive: true });
  if (!contained(await realpath(stateRoot), await realpath(worktrees))) throw new Error('Team path resolves outside stateRoot');
  const parallel = { workspace, stateRoot, stateRelative, teamId, baseHead, slots: {} };
  const branchPrefix = `pair/${encodeURIComponent(teamId)}/${randomUUID()}`;
  try {
    for (const name of ['driver', 'driver2']) {
      const slot = { path: join(worktrees, name), branch: `${branchPrefix}/${name}`, baseHead, stateRelative };
      checkOwner(parallel, slot.path);
      await git(workspace, [...checkout, 'worktree', 'add', '-b', slot.branch, slot.path, baseHead]);
      parallel.slots[name] = slot;
    }
    if (await head(workspace) !== baseHead) throw new Error('Primary HEAD changed while creating Driver worktrees');
    return parallel;
  } catch (error) {
    await removeDriverWorktrees(parallel);
    throw error;
  }
}

/** Snapshot working content through a temporary index; the Driver's index/HEAD stay intact. */
export async function snapshotCandidate(slot, allowedPaths) {
  commitId(slot.baseHead);
  if (!Array.isArray(allowedPaths)) throw new Error('Candidate write scope is required');
  const allowed = allowedPaths.map(pathName);
  const gitDir = await git(slot.path, ['rev-parse', '--absolute-git-dir']);
  const index = join(gitDir, `pair-index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    await git(slot.path, ['read-tree', slot.baseHead], { env });
    await git(slot.path, ['add', '-A', '--', '.', ...exclude([...new Set(['.pair-programming', slot.stateRelative].filter(Boolean))])], { env });
    const files = (await git(slot.path, ['diff', '--cached', '--name-only', '--no-renames', '-z', slot.baseHead, '--'], { env })).split('\0').filter(Boolean);
    for (const file of files) {
      const normalized = pathName(file);
      if (!allowed.some(path => under(normalized, path))) throw new Error(`Candidate escapes declared write scope: ${file}`);
    }
    const tree = await git(slot.path, ['write-tree'], { env });
    const commit = await git(slot.path, [...identity, 'commit-tree', tree, '-p', slot.baseHead, '-m', 'DSH Pair isolated candidate']);
    await git(slot.path, ['update-ref', `refs/pair/candidates/${randomUUID()}`, commit]);
    return { commit, baseHead: slot.baseHead, files };
  } finally {
    await unlink(index).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await unlink(`${index}.lock`).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

/** Serialize promotion. Failed merge/oracle work remains outside the canonical checkout. */
/**
 * Integration replays the frozen oracles and the whole-suite command inside a
 * DISPOSABLE git worktree, and a worktree materialises TRACKED files only. An app
 * whose runtime data (data/jobs.json) is gitignored therefore cannot be verified
 * there: its oracles print PREREQ and its suite exits through an instrument
 * marker, and the integration reads both as a failed candidate.
 *
 * Seeding is opt-in per RUN. The declaration travels with the board as
 * `parallel.runtimePaths`, and nothing else is ever copied — a sweep of the
 * ignored set would carry secrets, real user data and stale results into a tree
 * nobody reviewed, which is exactly what the first patch for this bug did by
 * hardcoding `data`.
 *
 * Links are never followed and never copied, and `lstat` is load-bearing here
 * rather than stylistic: a Windows directory junction reports `isDirectory()`
 * through `stat` and `isSymbolicLink()` through `lstat`, and the
 * `git worktree remove --force` at the end of the caller DELETES THROUGH a
 * junction — measured on this host, the junction's source directory came back
 * empty with exit code 0. A copy or a traversal here would hand the user's real
 * runtime data to that removal.
 */
function lstatOrUndefined(path) {
  try { return lstatSync(path); } catch { return undefined; }
}
const LINKED_RUNTIME_INPUT = 'not a regular file or a real directory (a link is never followed or copied)';
const HELD_RUNTIME_INPUT = 'already present in the merged tree; the candidate wins';
/** One declaration may name a file or a directory. A directory is enumerated
 * because the run cannot declare an ignored tree without reading it, and a file
 * list that rots is a worse default than a declaration that stays explicit. */
function collectRuntimeInputs(source, rel, plan, report) {
  const stat = lstatOrUndefined(source);
  if (stat === undefined) { report.missing.push(rel); return; }
  if (stat.isFile()) { plan.push({ rel, source }); return; }
  if (!stat.isDirectory()) { report.skipped.push({ path: rel, reason: LINKED_RUNTIME_INPUT }); return; }
  for (const name of readdirSync(source).sort()) collectRuntimeInputs(join(source, name), rel + '/' + name, plan, report);
}
/**
 * Walk the ANCESTORS of one declared path under `root`, refusing any segment that
 * is a link, and (for a target) creating the missing ones ONE AT A TIME so each new
 * segment is checked before anything is written under it.
 *
 * Why the leaf check is not enough (J1, measured): `lstat` on the final node, plus a
 * LEXICAL containment test, both still pass when an ANCESTOR is a junction. Declaring
 * `data/input.json` while `workspace/data` points outside the workspace copied the
 * external file in; with `worktree/local` pointing outside, the copy created its file
 * outside the checkout — a read and a write beyond the boundary this function exists
 * to hold. Ancestors are therefore checked segment by segment, and the resolved real
 * path is checked against the real root as well.
 *
 * @returns {{ok:true, dir:string}|{ok:false, reason:string}} `dir` is the leaf's parent.
 */
function guardAncestors(root, rel, { create = false } = {}) {
  const segments = String(rel).replaceAll('\\', '/').split('/').filter(Boolean);
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    const next = join(current, segment);
    const stat = lstatOrUndefined(next);
    if (stat === undefined) {
      if (!create) return { ok: false, reason: 'a directory on the declared path does not exist: ' + next };
      try { mkdirSync(next); } catch (error) { return { ok: false, reason: 'could not create ' + next + ': ' + String(error?.message ?? error) }; }
      current = next;
      continue;
    }
    if (stat.isSymbolicLink()) return { ok: false, reason: 'refused: a link is on the path (' + next + '), and this copy never follows one' };
    if (!stat.isDirectory()) return { ok: false, reason: 'refused: a non-directory is on the path (' + next + ')' };
    current = next;
  }
  return { ok: true, dir: current };
}

/** The real root, so a resolved path can be compared with what it really is. */
function realRootOf(root) {
  try { return realpathSync(root); } catch { return resolve(root); }
}
const stillInside = (root, path) => {
  const rel = relative(root, path);
  // 'At or inside', not 'strictly inside'. The target check below resolves the PARENT
  // directory, and for a declared file at the checkout root that parent IS the root, so a
  // strict reading refused a legal seed (declaring runtime.json reported seeded [] with a
  // misleading 'resolves outside the disposable checkout'). For the source check the
  // equality case cannot arise - a source is a file, and a file is never the workspace
  // root - so the relaxation changes nothing there.
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** `declared` is the run's own declaration, so an empty one copies nothing. */
export function seedRuntimeInputs(workspace, worktree, declared = []) {
  const report = { declared: [...declared], seeded: [], skipped: [], missing: [] };
  if (!declared.length) return report;
  const plan = [];
  for (const entry of declared) collectRuntimeInputs(join(workspace, entry), entry, plan, report);
  const realWorkspace = realRootOf(workspace);
  const realWorktree = realRootOf(worktree);
  const done = new Set();
  for (const { rel, source } of plan) {
    if (done.has(rel)) { report.skipped.push({ path: rel, reason: 'declared twice, or covered by another declaration' }); continue; }
    done.add(rel);
    const sourceGuard = guardAncestors(workspace, rel);
    if (!sourceGuard.ok) { report.skipped.push({ path: rel, reason: sourceGuard.reason }); continue; }
    let realSource;
    try { realSource = realpathSync(source); } catch (error) { report.skipped.push({ path: rel, reason: 'could not resolve the source: ' + String(error?.message ?? error) }); continue; }
    if (!stillInside(realWorkspace, realSource)) { report.skipped.push({ path: rel, reason: 'refused: the source resolves outside the workspace (' + realSource + ')' }); continue; }
    const targetGuard = guardAncestors(worktree, rel, { create: true });
    if (!targetGuard.ok) { report.skipped.push({ path: rel, reason: targetGuard.reason }); continue; }
    const target = join(targetGuard.dir, basename(rel));
    if (!contained(worktree, target)) { report.skipped.push({ path: rel, reason: 'resolves outside the disposable checkout' }); continue; }
    let realParent;
    try { realParent = realpathSync(targetGuard.dir); } catch (error) { report.skipped.push({ path: rel, reason: 'could not resolve the target directory: ' + String(error?.message ?? error) }); continue; }
    if (!stillInside(realWorktree, realParent)) { report.skipped.push({ path: rel, reason: 'refused: the target resolves outside the disposable checkout (' + realParent + ')' }); continue; }
    // The candidate wins. A tracked file the merge already brought in is part of
    // the tree that gets verified; a seed is an environment input, not an override.
    if (lstatOrUndefined(target) !== undefined) { report.skipped.push({ path: rel, reason: HELD_RUNTIME_INPUT }); continue; }
    try {
      // The remaining window is between these checks and the copy itself. It is
      // narrow and this path is not exposed to an attacker, but it is a window:
      // the checks narrow it, they do not close it.
      copyFileSync(source, target);
      report.seeded.push(rel);
    } catch (error) { report.skipped.push({ path: rel, reason: 'could not be copied: ' + String(error?.message ?? error) }); }
  }
  return report;
}
/** A declared input the canonical workspace does not have leaves the merged tree
 * incomplete, and an oracle run there reports a missing pool exactly like a bad
 * candidate does. The seed report travels on every successful receipt; a failure
 * in an incomplete tree has to name the environment before its reader concludes
 * that the code failed. */
function environmentDiagnostic(error, report) {
  if (!(error instanceof Error) || !report.missing.length) return error;
  error.message += '\nINTEGRATION_ENVIRONMENT: declared runtime input(s) absent from the canonical workspace: '
    + report.missing.join(', ') + '; this run describes the integration environment, not the candidate';
  error.runtimeSeed = report;
  return error;
}

export async function integrateCandidate(parallel, candidate, { verify, signal } = {}) {
  if (typeof verify !== 'function') throw new Error('Integration requires a merged-tree verification callback');
  commitId(candidate.commit);
  return withLock(`pair-integration:${fold(await rootOf(parallel.workspace))}`, async () => {
    signal?.throwIfAborted();
    const previousHead = await head(parallel.workspace);
    await clean(parallel.workspace, [parallel.stateRelative]);
    const path = join(parallel.stateRoot, parallel.teamId, 'worktrees', `integration-${randomUUID()}`);
    checkOwner(parallel, path);
    let created = false;
    try {
      // Finish each Git mutation before observing cancellation, so cleanup knows its outcome.
      await git(parallel.workspace, [...checkout, 'worktree', 'add', '--detach', path, previousHead]); created = true;
      signal?.throwIfAborted();
      await git(path, [...checkout, ...identity, 'merge', '--no-edit', '--no-ff', candidate.commit]);
      const mergedHead = await head(path);
      signal?.throwIfAborted();
      const runtimeSeed = seedRuntimeInputs(parallel.workspace, path, parallel.runtimePaths ?? []);
      try {
        if (await verify(path) === false) throw new Error('Merged-tree verification failed');
      } catch (error) { throw environmentDiagnostic(error, runtimeSeed); }
      signal?.throwIfAborted();
      await clean(path, []);
      if (await head(path) !== mergedHead) throw new Error('Integration HEAD changed during verification');
      if (await head(parallel.workspace) !== previousHead) throw new Error('Primary HEAD changed during verification; candidate is stale');
      await clean(parallel.workspace, [parallel.stateRelative]);
      // Do not interrupt Git mid-promotion: cancellation is checked immediately above.
      await git(parallel.workspace, [...checkout, 'merge', '--ff-only', '--no-edit', mergedHead]);
      const promotedHead = await head(parallel.workspace);
      if (promotedHead !== mergedHead) throw new Error('Primary HEAD changed during promotion; recertify the current tree');
      return { head: promotedHead, previousHead, runtimeSeed };
    } finally {
      // This is an owned disposable checkout, never a Driver's or user's working directory.
      if (created) await git(parallel.workspace, ['worktree', 'remove', '--force', path]);
    }
  });
}

/** Clean slots may be removed. Dirty work is preserved and reported, never force-deleted. */
export async function removeDriverWorktrees(parallel) {
  const warnings = [];
  for (const slot of Object.values(parallel.slots)) {
    try {
      checkOwner(parallel, slot.path);
      await git(parallel.workspace, ['worktree', 'remove', slot.path]);
    } catch (error) { warnings.push(`Preserved Driver worktree ${slot.path}: ${error.message}`); }
  }
  return warnings;
}

/** Explicit reads and writes include directory prefixes; resources serialize shared state. */
export function scopeConflicts(left, right) {
  if (!Array.isArray(left?.writes) || !left.writes.length || !Array.isArray(right?.writes) || !right.writes.length) return true;
  try {
    const lw = left.writes.map(pathName), rw = right.writes.map(pathName);
    const lr = (left.reads ?? []).map(pathName), rr = (right.reads ?? []).map(pathName);
    const resource = value => fold(String(value));
    return lw.some(a => [...rw, ...rr].some(b => overlaps(a, b))) || rw.some(a => lr.some(b => overlaps(a, b))) ||
      (left.resources ?? []).some(a => (right.resources ?? []).map(resource).includes(resource(a)));
  } catch { return true; }
}
