/** Git-backed Driver isolation. Only verified integration trees reach the user's branch. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, unlink } from 'node:fs/promises';
import { resolve, relative, join, isAbsolute, sep } from 'node:path';
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
      if (await verify(path) === false) throw new Error('Merged-tree verification failed');
      signal?.throwIfAborted();
      await clean(path, []);
      if (await head(path) !== mergedHead) throw new Error('Integration HEAD changed during verification');
      if (await head(parallel.workspace) !== previousHead) throw new Error('Primary HEAD changed during verification; candidate is stale');
      await clean(parallel.workspace, [parallel.stateRelative]);
      // Do not interrupt Git mid-promotion: cancellation is checked immediately above.
      await git(parallel.workspace, [...checkout, 'merge', '--ff-only', '--no-edit', mergedHead]);
      const promotedHead = await head(parallel.workspace);
      if (promotedHead !== mergedHead) throw new Error('Primary HEAD changed during promotion; recertify the current tree');
      return { head: promotedHead, previousHead };
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
