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
import { oracleDirectory } from '../state/artifacts.js';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { exitSemantics, instrumentFailure } from '../protocol/command-shape.js';

const execFileP = promisify(execFile);
/** An acceptance test that needs longer than this is not a fast oracle. */
const ORACLE_TIMEOUT_MS = 300_000; // sprint2 t-1 oracle 36-group GREEN ~90-160s (d-s2-amend-8, r-9 evidence)

/** The sole directory where a Navigator may author acceptance artifacts. */
export const ORACLE_ROOT = '.pair-oracles';

function oracleRootFor(taskId, team) {
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(taskId)) {
    throw new Error('oracle task_id must be a simple identifier');
  }
  return `${oracleDirectory(team)}/${taskId}`;
}

/**
 * Reject an oracle that is not owned by its task's reserved test directory.
 * This leaves the Navigator one narrow, auditable write capability without
 * handing it a shell that can modify production files.
 */
export function assertTaskOracleFiles(taskId, files, team) {
  const root = `${oracleRootFor(taskId, team)}/`;
  for (const file of files ?? []) {
    const normalized = String(file ?? '').replaceAll('\\', '/');
    if (!normalized.startsWith(root) || normalized.slice(root.length) === '') {
      throw new Error(`oracle file "${String(file)}" must be under ${root}`);
    }
  }
  return root.slice(0, -1);
}

/** Artifacts this plugin can parse without running them. */
const PARSABLE_ARTIFACT = /\.(?:mjs|cjs|js)$/i;

/**
 * Does the oracle's OWN artifact parse?
 *
 * The freeze gate demands a FAILING command, so it cannot tell a real red from a
 * program that never got past its own syntax: a node run of an acceptance file with
 * an unescaped quote exits 1, and the freeze accepts that as the RED the whole task
 * is measured against. That standard then fails identically at every later verdict —
 * 'acceptance still unmet' — while no implementation could ever turn it green. The
 * seat that writes it has no shell (I1), and the seat that reviews it reads for
 * meaning, not for quoting: measured, two seats read the whole file and both missed
 * one unescaped pair on line 682.
 *
 * So the plugin parses the artifact itself, deterministically, before anything is
 * sealed. The parse is done on the FILE rather than inferred from the run's output
 * on purpose: an acceptance test is allowed to assert that the code under test
 * throws a SyntaxError, and a text match could not tell those two apart.
 *
 * @returns {Promise<string|undefined>} the first parse failure, or undefined.
 */
/**
 * The same parse check for content that has NOT been written yet, so a broken draft
 * is refused before it can replace a good artifact. The draft is parsed in the OS
 * temp directory: nothing about the team's artifact tree is touched to answer the
 * question.
 *
 * @returns {Promise<string|undefined>} the parse failure, or undefined.
 */
export async function draftSyntaxProblem(path, content) {
  const normalized = String(path ?? '').replaceAll('\\\\', '/');
  if (!PARSABLE_ARTIFACT.test(normalized)) return undefined;
  const directory = await mkdtemp(join(tmpdir(), 'pair-oracle-parse-'));
  const draft = join(directory, normalized.split('/').pop() || 'draft.mjs');
  try {
    await writeFile(draft, String(content ?? ''), 'utf8');
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  try {
    await execFileP(process.execPath, ['--check', draft], { timeout: 30_000 });
    return undefined;
  } catch (error) {
    const output = (String(error?.stdout ?? '') + String(error?.stderr ?? '')) || String(error?.message ?? error);
    return 'this artifact does not parse:' + String.fromCharCode(10)
      + output.split(String.fromCharCode(10)).map(line => line.trimEnd()).filter(Boolean).slice(-6).join(String.fromCharCode(10));
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function oracleSyntaxProblem(workspace, files) {
  for (const rel of files ?? []) {
    const normalized = String(rel ?? '').replaceAll('\\\\', '/');
    if (!PARSABLE_ARTIFACT.test(normalized)) continue;
    const absolute = resolveInside(workspace, normalized);
    try {
      await execFileP(process.execPath, ['--check', absolute], { cwd: workspace, timeout: 30_000 });
    } catch (error) {
      const output = (String(error?.stdout ?? '') + String(error?.stderr ?? '')) || String(error?.message ?? error);
      return 'the acceptance artifact ' + normalized + ' does not parse:' + String.fromCharCode(10)
        + output.split(String.fromCharCode(10)).map(line => line.trimEnd()).filter(Boolean).slice(-6).join(String.fromCharCode(10));
    }
  }
  return undefined;
}

/** Resolve one Navigator-authored oracle artifact, refusing path escapes. */
export function resolveTaskOracleFile(workspace, taskId, file, team) {
  const root = assertTaskOracleFiles(taskId, [file], team);
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
  const hash = createHash('sha256').update('git-worktree-v2\0');
  // Empty repositories have no HEAD and deliberately use the tree fallback.
  hash.update(await run(['rev-parse', '--verify', 'HEAD'])).update('\0');
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

/** Directories that are never the candidate under review, wherever they nest. */
const TREE_VENDOR_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'jspm_packages',
  '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox',
  '.turbo', '.parcel-cache', '.gradle', '.terraform',
]);

/** How many entries get a stat; beyond this the walk records paths and types only. */
const TREE_STAT_BUDGET = 250_000;

/** Stat workers. Measured: 40k stats = 18s serial, 8s at 64; the pool never reorders the digest. */
const TREE_STAT_CONCURRENCY = 48;

/**
 * How much file CONTENT the walk will read. Content is the strong half of a
 * fingerprint and it is what makes a byte-identical restore restore the digest:
 * measured, an existing test rewrites an oracle file and writes the original
 * bytes back, and the old content-only digest correctly saw no change, while a
 * metadata-only digest reported one because the mtime had moved. So content is
 * used wherever it fits inside this budget and metadata carries the rest.
 */
const TREE_CONTENT_BUDGET = 64 * 1024 * 1024;

/**
 * Bounded metadata walk. `roots` (workspace-relative) scopes it to the files a
 * task can actually touch; without them it covers the whole workspace.
 *
 * Measured (2026-09-10, live /pair run): the byte-hashing version of this
 * function did not finish inside 150s on a workspace of 222,820 files / 2.3 GB,
 * because `captureEvidenceBoundary` calls it on EVERY cycle step — so an oracle
 * freeze hung for the whole 600s member turn, and pair_propose, pair_green,
 * pair_verify, pair_gate_check, pair_integrate and pair_stop all call it too.
 * Nothing in the offline suite could see it: the suite runs inside the plugin
 * repository, which IS a Git repository, so it always took the fast path.
 *
 * Why scoping is the primary mechanism, not an optimisation. Measured on the
 * workspace this bug was found in: 222,820 files / 2.3 GB, of which 147,000 are
 * experiment task trees an operator legitimately keeps beside the project. A
 * non-Git workspace has no cheaper way to notice a changed file than to stat it,
 * and Windows charges ~0.5-1ms per stat (40,000 stats: 18s serial, 8s at
 * concurrency 64), so no budget makes a whole-tree scan affordable for something
 * called on every cycle step. The scoped set is the task's own declared write
 * scope plus its sealed oracle files, which is what a candidate can change.
 *
 * The digest is METADATA per entry — path, size, mtime — never file bytes: this
 * is a boundary comparison, not a content address. Any file added, removed,
 * resized or rewritten moves it. A content change that preserves both size and
 * modification time does not, and that residual is named rather than paid for
 * with an unbounded walk. A Git workspace never reaches this function.
 */
async function treeFingerprint(workspace, excludedTopLevel) {
  const hash = createHash('sha256').update('tree-metadata-v3\0');
  // Phase 1 — enumerate in a deterministic order. Only dirents, no stats: this is
  // the part that must stay stable across the two readings of a boundary.
  const entries = [];
  async function enumerate(dir) {
    const listing = await readdir(dir, { withFileTypes: true });
    for (const entry of listing.sort((a, b) => a.name.localeCompare(b.name))) {
      if (dir === workspace && excludedTopLevel.has(entry.name)) continue;
      if (TREE_VENDOR_DIRS.has(entry.name)) continue;
      const absolute = join(dir, entry.name);
      const rel = relative(workspace, absolute).replaceAll('\\', '/');
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        entries.push({ rel, dir: true });
        await enumerate(absolute);
      } else entries.push({ rel, dir: false });
    }
  }
  await enumerate(workspace);
  // Phase 2 — stat concurrently. Measured on this host: 40,000 stats take 18s
  // serially and 8s at concurrency 64, so the pool is what keeps a whole-tree
  // reading inside a tool call instead of a member's turn.
  const stats = new Array(entries.length);
  let cursor = 0;
  let stated = 0;
  let degraded = 0;
  let contentBytes = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= entries.length) return;
      if (stated >= TREE_STAT_BUDGET) { degraded += 1; continue; }
      stated += 1;
      stats[index] = await lstat(join(workspace, entries[index].rel)).catch(() => undefined);
    }
  }
  await Promise.all(Array.from({ length: Math.min(TREE_STAT_CONCURRENCY, entries.length) }, worker));
  // Phase 3 — hash in enumeration order, so concurrency can never reorder the digest.
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const info = stats[index];
    if (entry.dir) { hash.update(entry.rel).update('\0d\0'); continue; }
    if (info === undefined) { hash.update(entry.rel).update('\0leaf\0'); continue; }
    if (info.isSymbolicLink()) { hash.update(entry.rel).update('\0link\0'); continue; }
    if (info.isDirectory()) { hash.update(entry.rel).update('\0d\0'); continue; }
    if (!info.isFile()) { hash.update(entry.rel).update('\0other\0'); continue; }
    // Content first, metadata as the bounded tail: see TREE_CONTENT_BUDGET.
    if (contentBytes + info.size <= TREE_CONTENT_BUDGET) {
      const bytes = await readFile(join(workspace, entry.rel)).catch(() => undefined);
      if (bytes === undefined) { hash.update(entry.rel).update('\0unreadable\0'); continue; }
      contentBytes += info.size;
      hash.update(entry.rel).update('\0c\0').update(bytes).update('\0');
      continue;
    }
    hash.update(entry.rel).update('\0f\0').update(String(info.size)).update('\0').update(String(Math.trunc(info.mtimeMs))).update('\0');
  }
  hash.update(degraded > 0 ? '\0degraded:' + String(degraded) : '\0full');
  return hash.digest('hex');
}
/**
 * Stable snapshot of the candidate worktree at a gate boundary.  Git makes
 * the normal path cheap (HEAD, diffs and non-ignored files). The non-git/empty
 * repository fallback hashes metadata under a hard entry budget — see
 * treeFingerprint, and the measured hang that made it bounded.
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
 *
 * `instrumentExitCodes` is the exit-code declaration the frozen execution
 * contract carries (pair_oracle's `instrument_exit_codes`, or the same field on
 * a cycle's proposal for its verify plan). A declared instrument exit is
 * REFUSED here rather than returned, because the four call sites that consume a
 * run did not agree about what a non-zero exit means, and one of them
 * (pair_integrate) read every one of them as a failed candidate: measured, a
 * run that could not reach its fixture (exit 2) was reported as
 * INTEGRATION_ORACLE_FAILED while the team's own rule said exit 2 carries no
 * product verdict. The judgement belongs where the command is run, once.
 *
 * A spawn failure and a not-found exit are still RETURNED, not thrown: every
 * consumer already asks about those through requireProductRun, and only the
 * declaration can settle the instrument question.
 *
 * @returns {Promise<{command:string, exit:number|string, outputTail:string, outputSha:string}>}
 */
export async function runOracleCommand(workspace, command, { signal, timeoutMs = ORACLE_TIMEOUT_MS, instrumentExitCodes } = {}) {
  const cmd = String(command ?? '').trim();
  if (cmd === '') throw new Error('the oracle has no command to run');
  let output;
  let exit = 0;
  try {
    const { stdout, stderr } = await execFileP(cmd, [], { shell: true, cwd: workspace, signal, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    output = String(stdout) + String(stderr);
  } catch (error) {
    output = String(error.stdout ?? '') + String(error.stderr ?? '');
    exit = signal?.aborted || error.name === 'AbortError' ? 'cancelled'
      : error.killed && (error.code === undefined || error.code === null) ? 'timeout' : error.code ?? 'error';
  }
  const run = {
    command: cmd,
    exit,
    outputTail: output.split('\n').slice(-40).join('\n'),
    outputSha: createHash('sha256').update(output).digest('hex'),
  };
  const instrument = instrumentFailure(run, exitSemantics({ instrumentExitCodes }));
  if (instrument !== undefined) throw new Error(`VERIFICATION_INFRASTRUCTURE: ${instrument}`);
  return run;
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
    const from = dirname(rel);
    for (const match of text.matchAll(/['"`]([\w./@-]{3,200})['"`]/g)) {
      const token = match[1].split('\\').join('/');
      if (!token.includes('/') && !token.includes('.')) continue;
      if (token.startsWith(ORACLE_ROOT)) continue;
      candidates.add(token.replace(/^\.\//, ''));
      // An oracle lives under .pair-oracles/<task_id>/, so the import that
      // reaches the product is written relative to the ORACLE, not to the
      // workspace root: '../../src/thing.js' escapes the workspace when it is
      // resolved from the root and was dropped, which reported every correctly
      // wired oracle as SELF-CONTAINED — the warning fired on exactly the
      // oracles it exists to tell apart from tautological ones.
      const fromOracle = join(from, token).split(sep).join('/');
      if (!fromOracle.startsWith('..') && !fromOracle.startsWith(ORACLE_ROOT)) candidates.add(fromOracle);
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
