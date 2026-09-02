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
import { readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';

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
