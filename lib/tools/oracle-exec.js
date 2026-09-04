/**
 * The oracle's filesystem and command halves (N1/N2): digest the frozen
 * acceptance files, and run the acceptance command.
 *
 * Split from protocol/oracle.js so the decision logic stays pure and unit
 * testable; everything here touches the world. The command runs through the
 * shell with the same trust boundary as `dodCommand` — it is authored by the
 * Navigator inside the workspace the team already writes to.
 *
 * @module dsh-pair-programming/tools/oracle-exec
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const execFileP = promisify(execFile);
/** An acceptance test that needs longer than this is not a fast oracle. */
const ORACLE_TIMEOUT_MS = 300_000; // sprint2 t-1 oracle 36-group GREEN ~90-160s (d-s2-amend-8, r-9 evidence)

/** The sole directory where a Navigator may author acceptance artifacts. */
export const ORACLE_ROOT = '.pair-oracles';

function oracleRootFor(taskId) {
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(taskId)) {
    throw new Error('oracle task_id must be a simple identifier');
  }
  return `${ORACLE_ROOT}/${taskId}`;
}

/**
 * Reject an oracle that is not owned by its task's reserved test directory.
 * This leaves the Navigator one narrow, auditable write capability without
 * handing it a shell that can modify production files.
 */
export function assertTaskOracleFiles(taskId, files) {
  const root = `${oracleRootFor(taskId)}/`;
  for (const file of files ?? []) {
    const normalized = String(file ?? '').replaceAll('\\', '/');
    if (!normalized.startsWith(root) || normalized.slice(root.length) === '') {
      throw new Error(`oracle file "${String(file)}" must be under ${root}`);
    }
  }
  return root.slice(0, -1);
}

/** Resolve one Navigator-authored oracle artifact, refusing path escapes. */
export function resolveTaskOracleFile(workspace, taskId, file) {
  const root = assertTaskOracleFiles(taskId, [file]);
  const target = resolveInside(workspace, String(file).replaceAll('\\', '/'));
  const oracleRoot = resolveInside(workspace, root);
  if (target === oracleRoot || !target.startsWith(oracleRoot + sep)) {
    throw new Error(`oracle file "${String(file)}" must be below ${root}/`);
  }
  return target;
}

/** Reject paths that escape the workspace before they are ever read. */
export function resolveInside(workspace, rel) {
  const abs = isAbsolute(rel) ? resolve(rel) : resolve(join(workspace, rel));
  const root = resolve(workspace);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`oracle file "${rel}" resolves outside the workspace — the frozen set must live in the tree under review`);
  }
  return abs;
}

/**
 * sha256 over the oracle file set: each file contributes its declared path and
 * its bytes, in sorted order, so the digest is stable across platforms and
 * sensitive to a single changed character.
 *
 * A missing file is not an error here — it hashes as a tombstone, so deleting
 * the oracle changes the digest instead of crashing the verification.
 */
export async function digestOracleFiles(workspace, files) {
  const hash = createHash('sha256');
  for (const rel of [...files].sort()) {
    hash.update(rel).update('\0');
    try {
      hash.update(await readFile(resolveInside(workspace, rel)));
    } catch {
      hash.update('<<missing>>');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function gitFingerprint(workspace, excludedTopLevel) {
  const run = async (args) => {
    const { stdout } = await execFileP('git', args, {
      cwd: workspace, maxBuffer: 16 * 1024 * 1024,
    });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout));
  };
  const hash = createHash('sha256').update('git-worktree-v1\0');
  hash.update(await run(['diff', '--binary'])).update('\0');
  hash.update(await run(['diff', '--cached', '--binary'])).update('\0');
  const untracked = (await run(['ls-files', '--others', '--exclude-standard', '-z']))
    .toString('utf8').split('\0').filter(Boolean).sort();
  for (const file of untracked) {
    if (excludedTopLevel.has(file.split('/')[0])) continue;
    hash.update(file).update('\0').update(await readFile(resolveInside(workspace, file))).update('\0');
  }
  return hash.digest('hex');
}

async function treeFingerprint(workspace, excludedTopLevel) {
  const hash = createHash('sha256').update('tree-worktree-v1\0');
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (dir === workspace && excludedTopLevel.has(entry.name)) continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        hash.update(relative(workspace, absolute).replaceAll('\\', '/')).update('\0');
        hash.update(await readFile(absolute)).update('\0');
      }
    }
  }
  await visit(workspace);
  return hash.digest('hex');
}

/**
 * Stable snapshot of the candidate worktree at a gate boundary.  Git makes
 * the normal path cheap (diffs plus non-ignored files); the bounded fallback
 * keeps the guarantee for small non-git workspaces used in integrations.
 */
export async function workspaceFingerprint(workspace, { stateDir } = {}) {
  const excluded = new Set(['.git']);
  if (typeof stateDir === 'string' && stateDir !== '') excluded.add(stateDir.split(/[\\/]/)[0]);
  try {
    return await gitFingerprint(workspace, excluded);
  } catch {
    return treeFingerprint(workspace, excluded);
  }
}

/**
 * Run the oracle command in the workspace.
 * @returns {Promise<{command:string, exit:number|string, outputTail:string, outputSha:string}>}
 */
export async function runOracleCommand(workspace, command) {
  const cmd = String(command ?? '').trim();
  if (cmd === '') throw new Error('the oracle has no command to run');
  let output;
  let exit = 0;
  try {
    const { stdout, stderr } = await execFileP(cmd, [], { shell: true, cwd: workspace, timeout: ORACLE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    output = String(stdout) + String(stderr);
  } catch (error) {
    output = String(error.stdout ?? '') + String(error.stderr ?? '');
    exit = error.killed && error.code === undefined ? 'timeout' : error.code ?? 'error';
  }
  return {
    command: cmd,
    exit,
    outputTail: output.split('\n').slice(-40).join('\n'),
    outputSha: createHash('sha256').update(output).digest('hex'),
  };
}

/**
 * How much of the system an oracle can actually see.
 *
 * Measured failure: in a replayed v3 session all three frozen oracles asserted
 * "does this probe file exist", and the probes were 12 bytes the Driver simply
 * created. Every one froze RED and turned GREEN, and none of them could have
 * detected anything about the code under review. The team's own retro flagged
 * it ("t-2 需要一次真实篡改回放，而不仅是缺探针 RED").
 *
 * `redProblem` cannot catch this: such an oracle really does fail today. What
 * distinguishes it is that GREEN is reachable by creating a file only the
 * oracle reads — it never touches anything that already exists. That is
 * cheaply detectable: scan the frozen artifacts for path-like literals and see
 * whether any of them resolve to something in the tree outside the oracle
 * directory.
 *
 * Deliberately a SIGNAL, not a refusal: a spike whose deliverable is a probe is
 * legitimate, and a heuristic should not be able to block legitimate work. It
 * is recorded on the freeze and surfaced in pair_status, the board digest and
 * the retro, so a tautological oracle is visible instead of quietly passing.
 *
 * @returns {Promise<{selfContained:boolean, touches:string[]}>}
 */
export async function assessOracleReach(workspace, files) {
  const candidates = new Set();
  for (const rel of files ?? []) {
    let text;
    try {
      text = await readFile(resolveInside(workspace, rel), 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(/['"`]([\w./@-]{3,200})['"`]/g)) {
      const token = match[1].split('\\').join('/');
      if (!token.includes('/') && !token.includes('.')) continue;
      if (token.startsWith(ORACLE_ROOT)) continue;
      candidates.add(token.replace(/^\.\//, ''));
    }
  }
  const touches = [];
  for (const token of candidates) {
    try {
      const abs = resolveInside(workspace, token);
      await stat(abs);
      touches.push(token);
    } catch {
      // not a path in this tree, or outside it: not a reach either way
    }
  }
  touches.sort();
  return { selfContained: touches.length === 0, touches: touches.slice(0, 10) };
}
