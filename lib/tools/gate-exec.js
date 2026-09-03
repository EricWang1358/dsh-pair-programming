/**
 * Gate command executor (M7'): the gate runs config.dodCommand itself instead of trusting
 * pasted evidence text. Successes cache under a content digest of the workspace; any changed
 * byte reruns; failures never cache (they may be environmental). The digest EXCLUDES the
 * state root — cache writes must not invalidate themselves. Known gap (M12'a, honest): this
 * proves the workspace passes at gate time, not the per-step tree REFACTOR touched (0.3.x).
 * The command runs through the shell: a deployment-owner setting on the same trust boundary
 * as dod/memberProvider; the injection surface is the owner's own.
 *
 * @module dsh-pair-programming/tools/gate-exec
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

const execFileP = promisify(execFile);
/** Honest constant: one knob fewer than a dodTimeoutMs config key would be. */
const GATE_TIMEOUT_MS = 120_000;
/** Workspaces larger than this never cache — digest cost beats the rerun. */
const MAX_DIGEST_FILES = 500;

/** sha256 over every tracked+untracked-not-ignored file's bytes (state root excluded); undefined when it cannot be computed. */
export async function workspaceDigest(workspace, stateRoot) {
  let files;
  try {
    const { stdout } = await execFileP('git', ['-C', workspace, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { maxBuffer: 16 * 1024 * 1024 });
    files = stdout.split('\0').filter(Boolean).sort();
  } catch {
    return undefined;
  }
  if (files.length === 0 || files.length > MAX_DIGEST_FILES) return undefined;
  const hash = createHash('sha256');
  try {
    for (const rel of files) {
      const abs = join(workspace, rel);
      if (stateRoot !== undefined && (abs === stateRoot || abs.startsWith(stateRoot + sep))) continue;
      hash.update(rel).update(await readFile(abs));
    }
  } catch {
    return undefined;
  }
  return hash.digest('hex');
}

/** Run the configured DoD command outside any lock; successes cache by content digest, failures always rerun. */
export async function runDodCommand(config, workspace, cache, stateRoot) {
  const command = String(config.dodCommand ?? '').trim();
  if (command === '') return { skipped: true, reason: 'dodCommand unset' };
  const digest = await workspaceDigest(workspace, stateRoot);
  if (cache && digest !== undefined) {
    const hit = await cache.getGateResult(command, digest);
    if (hit !== undefined) return { ...hit, cached: true };
  }
  let result;
  try {
    const { stdout, stderr } = await execFileP(command, [], { shell: true, cwd: workspace, timeout: GATE_TIMEOUT_MS });
    result = { command, exit: 0, output: String(stdout) + String(stderr) };
  } catch (error) {
    const tail = (String(error.stdout ?? '') + String(error.stderr ?? '')).split('\n').slice(-40).join('\n');
    const exit = error.killed && error.code === undefined ? 'timeout' : error.code ?? 'error';
    return { command, exit, outputTail: tail, cached: false };
  }
  if (cache && digest !== undefined) await cache.setGateResult(command, digest, result);
  return { ...result, cached: false };
}

/**
 * Do the artifacts the task promised actually exist?
 *
 * Measured failure: a pair arm completed a task through a valid gate pass with
 * `patch.diff` and `self-report.json` — its own stated deliverables — never
 * written. Every process check was green because every process check asks
 * about the process. Empty counts as missing: a zero-byte patch is the shape a
 * timed-out run leaves behind, and it must not read as delivery.
 */
export async function checkDeliverables(workspace, deliverables) {
  const wanted = (deliverables ?? []).map(v => String(v).trim()).filter(Boolean);
  if (wanted.length === 0) return { ok: true, checked: [] };
  const missing = [];
  const checked = [];
  for (const rel of wanted) {
    try {
      const abs = resolveInsideWorkspace(workspace, rel);
      const st = await stat(abs);
      if (!st.isFile() || st.size === 0) missing.push(`${rel} (${st.isFile() ? 'empty' : 'not a file'})`);
      else checked.push(`${rel} (${st.size}B)`);
    } catch {
      missing.push(`${rel} (absent)`);
    }
  }
  return { ok: missing.length === 0, missing, checked };
}

function resolveInsideWorkspace(workspace, rel) {
  const abs = isAbsolute(rel) ? resolve(rel) : resolve(join(workspace, rel));
  const root = resolve(workspace);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`deliverable "${rel}" resolves outside the workspace`);
  }
  return abs;
}

/**
 * Did the diff stay inside the files some proposal declared?
 *
 * A cycle names files[] before it may start; that declaration is what lets the
 * Navigator size the blast radius. When the diff reaches files nobody
 * proposed, the work grew past the plan without anyone deciding to allow it —
 * which is how a change aimed at one behaviour silently rewrites another. In a
 * measured run a fix for comma handling also altered an existing list/tuple
 * contract and regressed it; both the frozen oracle and the whole P2P suite
 * stayed green, because neither was looking there.
 *
 * Tracked modifications only: untracked scratch and logs are noise, not scope.
 * Returns undefined when git cannot answer, so an unavailable probe never
 * manufactures a failure.
 */
export async function checkScope(workspace, declaredFiles, baseline) {
  const norm = (v) => String(v).split(String.fromCharCode(92)).join('/').replace(/^[.][/]/, '');
  const declared = new Set((declaredFiles ?? []).map(norm));
  // Anything already modified when the team formed is not this team's scope.
  // Without this the very first gate on any real working tree reports every
  // pre-existing edit as an undeclared file, and a check that cries wolf on
  // run one is a check people learn to pass with --force.
  const preexisting = new Set((baseline?.dirtyFiles ?? []).map(norm));
  let stdout;
  try {
    ({ stdout } = await execFileP('git', ['-C', workspace, 'diff', '--numstat', baseline?.ref ?? 'HEAD'], { maxBuffer: 16 * 1024 * 1024 }));
  } catch {
    return undefined;
  }
  const touched = [];
  let added = 0;
  let removed = 0;
  for (const line of String(stdout).split(String.fromCharCode(10))) {
    const m = line.trim().match(new RegExp('^(\\d+|-)\\t(\\d+|-)\\t(.+)$'));
    if (m === null) continue;
    if (m[1] !== '-') added += Number(m[1]);
    if (m[2] !== '-') removed += Number(m[2]);
    touched.push(m[3]);
  }
  const undeclared = touched.filter(f => !declared.has(f) && !preexisting.has(f));
  return {
    touched, undeclared, declared: [...declared], netLines: added - removed, added, removed,
    baselineRef: baseline?.ref ?? 'HEAD', excludedPreexisting: [...preexisting].filter(f => touched.includes(f)),
  };
}

/**
 * Snapshot what the tree already looked like when a team formed.
 *
 * Scope is a claim about what THIS team changed, so it needs a mark on the
 * wall from before the team existed. Returns undefined outside git, which is
 * how the scope check stays silent rather than guessing.
 */
export async function captureBaseline(workspace) {
  try {
    const { stdout: ref } = await execFileP('git', ['-C', workspace, 'rev-parse', 'HEAD'], { maxBuffer: 1024 * 1024 });
    const { stdout: dirty } = await execFileP('git', ['-C', workspace, 'diff', '--name-only', 'HEAD'], { maxBuffer: 16 * 1024 * 1024 });
    return {
      ref: String(ref).trim(),
      dirtyFiles: String(dirty).split(String.fromCharCode(10)).map(v => v.trim()).filter(Boolean),
      at: Date.now(),
    };
  } catch {
    return undefined;
  }
}
