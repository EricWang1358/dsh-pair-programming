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
import { readFile, stat, realpath, readdir, lstat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { exitSemantics, instrumentFailure } from '../protocol/command-shape.js';

const execFileP = promisify(execFile);
/** Honest constant: one knob fewer than a dodTimeoutMs config key would be. */
const GATE_TIMEOUT_MS = 120_000;
/** Workspaces larger than this never cache — digest cost beats the rerun. */
const MAX_DIGEST_FILES = 500;

/** sha256 over HEAD and tracked+untracked-not-ignored file bytes (state root excluded); undefined when it cannot be computed. */
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
    const { stdout: head } = await execFileP('git', ['-C', workspace, 'rev-parse', '--verify', 'HEAD'], { maxBuffer: 1024 * 1024 });
    hash.update('gate-candidate-v2\0').update(head).update('\0');
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

/**
 * Run the configured DoD command outside any lock; successes cache by content
 * digest, failures always rerun.
 *
 * `instrumentExitCodes` (option, or `config.instrumentExitCodes` for a
 * deployment-level declaration — pair_stop spreads config into this call, so a
 * declared instrument exit refuses the stop instead of reading as a red build)
 * is applied exactly as runOracleCommand applies an oracle's declaration: a
 * declared instrument failure is refused here, where no consumer can turn it
 * into a product verdict of its own.
 */
export async function runDodCommand(config, workspace, cache, stateRoot, { signal, instrumentExitCodes } = {}) {
  const command = String(config.dodCommand ?? '').trim();
  if (command === '') return { skipped: true, reason: 'dodCommand unset' };
  const digest = await workspaceDigest(workspace, stateRoot);
  if (cache && digest !== undefined) {
    const hit = await cache.getGateResult(command, digest);
    if (hit !== undefined) return { ...hit, cached: true };
  }
  let result;
  try {
    const { stdout, stderr } = await execFileP(command, [], { shell: true, cwd: workspace, signal, timeout: GATE_TIMEOUT_MS });
    result = { command, exit: 0, output: String(stdout) + String(stderr) };
  } catch (error) {
    const tail = (String(error.stdout ?? '') + String(error.stderr ?? '')).split('\n').slice(-40).join('\n');
    const exit = signal?.aborted || error.name === 'AbortError' ? 'cancelled'
      : error.killed && (error.code === undefined || error.code === null) ? 'timeout' : error.code ?? 'error';
    const failure = { command, exit, outputTail: tail, cached: false };
    const instrument = instrumentFailure(failure, exitSemantics({ instrumentExitCodes: instrumentExitCodes ?? config?.instrumentExitCodes }));
    if (instrument !== undefined) throw new Error(`VERIFICATION_INFRASTRUCTURE: ${instrument}`);
    return failure;
  }
  // Never cache a success whose command changed the candidate. Otherwise a
  // stale first gate can seed a passing cache hit when that tree is restored.
  if (cache && digest !== undefined && !signal?.aborted && await workspaceDigest(workspace, stateRoot) === digest) {
    await cache.setGateResult(command, digest, result);
  }
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
      const root = await realpath(workspace);
      const abs = await realpath(resolveInsideWorkspace(workspace, rel));
      resolveInsideWorkspace(root, abs);
      const st = await stat(abs);
      if (st.isDirectory()) {
        if (await directoryHasArtifact(abs)) checked.push(`${rel} (non-empty directory)`);
        else missing.push(`${rel} (directory has no non-empty regular file)`);
      } else if (!st.isFile() || st.size === 0) missing.push(`${rel} (${st.isFile() ? 'empty' : 'not a file'})`);
      else checked.push(`${rel} (${st.size}B)`);
    } catch (error) {
      missing.push(`${rel} (${error.code === 'ENOENT' ? 'absent' : error.message})`);
    }
  }
  return { ok: missing.length === 0, missing, checked };
}

// An artifact directory needs real content, not merely subdirectories or links.
// Bound inspection and never follow descendant links (including junctions).
async function directoryHasArtifact(root) {
  const pending = [root];
  let inspected = 0;
  while (pending.length) {
    const directory = pending.pop();
    for (const name of await readdir(directory)) {
      if (++inspected > 10000) throw new Error('directory inspection limit exceeded');
      const path = join(directory, name);
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile() && entry.size > 0) return true;
      if (entry.isDirectory()) pending.push(path);
    }
  }
  return false;
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
export async function checkScope(workspace, declaredFiles, baseline, inheritedFiles = []) {
  const norm = (v) => String(v).split(String.fromCharCode(92)).join('/').replace(/^[.][/]/, '');
  // git rename detection renders moves as brace paths; expand to both endpoints
  // so a declared rename is not misread as undeclared. Plain indexOf/slice only.
  const expandBraces = (v) => {
    const s = String(v);
    const open = s.indexOf('{');
    const arrow = s.indexOf(' => ', open + 1);
    const close = s.indexOf('}', arrow + 4);
    if (open < 0 || arrow < 0 || close < 0) return [s];
    const head = s.slice(0, open);
    const tail = s.slice(close + 1);
    const mid = s.slice(open + 1, close).split(' => ');
    if (mid.length !== 2) return [s];
    return [head + mid[0] + tail, head + mid[1] + tail];
  };
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
    for (const p of expandBraces(m[3])) touched.push(norm(p));
  }
  const inherited = new Set((inheritedFiles ?? []).map(norm));
  const undeclared = touched.filter(f => !declared.has(f) && !inherited.has(f) && !preexisting.has(f));
  return {
    touched, undeclared, declared: [...declared], inherited: [...inherited].filter(f => touched.includes(f)), netLines: added - removed, added, removed,
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
