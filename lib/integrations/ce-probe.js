/**
 * Read-only detection of a locally installed Compound Engineering plugin.
 *
 * What this module is allowed to do: read files. That is the whole contract.
 * It never downloads, never clones, never installs, and never writes into a
 * skill root — installing CE stays the user's own action, and detecting it
 * must not have side effects that a user did not ask for.
 *
 * The result is a FINGERPRINT, not a boolean. `path + version + commit +
 * skill count + our own allowlist digest` is what a recorded "linked" state is
 * bound to, exactly like a gate credential is bound to board and worktree: any
 * drift invalidates the link and the settings card asks for a re-probe, rather
 * than quietly serving skills from a tree that has since moved.
 *
 * fs access is injected so the whole module is unit-testable offline.
 *
 * @module dsh-pair-programming/integrations/ce-probe
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { CE_PLUGIN_NAME, CE_REVIEWED_SKILL_COUNT, CE_REVIEWED_VERSION, allowlistDigest } from './ce-catalog.js';

/** The manifest that identifies a CE checkout. */
export const CE_MANIFEST = '.claude-plugin/plugin.json';

const defaultIo = {
  readFile: (path) => readFile(path, 'utf8'),
  readdir: (path) => readdir(path, { withFileTypes: true }),
};

/**
 * Candidate roots, most authoritative first.
 *
 * An explicit path always wins. After it come the two places a CE checkout
 * actually lives on a developer machine: DSH's own package directory, and the
 * Claude Code plugin registry (whose v2 `installed_plugins.json` records an
 * absolute `installPath` per `<plugin>@<marketplace>` key).
 */
export function candidateRoots({ cePath, home = homedir(), installed } = {}) {
  const roots = [];
  const explicit = String(cePath ?? '').trim();
  if (explicit !== '') roots.push({ source: 'configured', path: explicit });
  roots.push({ source: 'dsh-packages', path: join(home, '.dsh', 'packages', 'compound-engineering-plugin') });
  for (const [key, rows] of Object.entries(installed?.plugins ?? {})) {
    if (!key.startsWith(`${CE_PLUGIN_NAME}@`)) continue;
    for (const row of Array.isArray(rows) ? rows : []) {
      const path = String(row?.installPath ?? '').trim();
      if (path !== '') roots.push({ source: 'claude-plugins', path });
    }
  }
  return roots;
}

/** Read the Claude Code install registry, or undefined when there is none. */
export async function readInstalledPlugins(home = homedir(), io = defaultIo) {
  try {
    const raw = await io.readFile(join(home, '.claude', 'plugins', 'installed_plugins.json'));
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a checkout's current commit without spawning git.
 *
 * A detached HEAD holds the sha directly; a branch HEAD points at a ref file,
 * and a repository whose refs have been packed keeps it in `packed-refs`. All
 * three are read-only file reads. Anything unresolvable returns undefined —
 * an unknown commit is a weaker fingerprint, never a failed probe.
 */
export async function readCommitSha(root, io = defaultIo) {
  let head;
  try {
    head = (await io.readFile(join(root, '.git', 'HEAD'))).trim();
  } catch {
    return undefined;
  }
  if (!head.startsWith('ref:')) return /^[0-9a-f]{7,40}$/i.test(head) ? head : undefined;
  const ref = head.slice(4).trim();
  try {
    return (await io.readFile(join(root, '.git', ref))).trim();
  } catch { /* packed */ }
  try {
    const packed = await io.readFile(join(root, '.git', 'packed-refs'));
    for (const line of packed.split('\n')) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && /^[0-9a-f]{7,40}$/i.test(sha ?? '')) return sha;
    }
  } catch { /* none */ }
  return undefined;
}

/** Directory names directly under `<root>/skills` — CE's own layout. */
async function readSkillNames(root, io) {
  try {
    const entries = await io.readdir(join(root, 'skills'));
    return entries.filter(entry => entry.isDirectory?.() ?? entry.isDirectory).map(entry => entry.name).sort();
  } catch {
    return undefined;
  }
}

/**
 * Inspect one candidate root.
 *
 * @returns {{ok:true, path:string, version:string, skillNames:string[]}|{ok:false, reason:string}}
 */
export async function inspectRoot(root, io = defaultIo) {
  if (typeof root !== 'string' || root.trim() === '') return { ok: false, reason: 'empty path' };
  if (!isAbsolute(root)) return { ok: false, reason: `not an absolute path: ${root}` };
  let manifest;
  try {
    manifest = JSON.parse(await io.readFile(join(root, CE_MANIFEST)));
  } catch {
    return { ok: false, reason: `no readable ${CE_MANIFEST}` };
  }
  if (manifest?.name !== CE_PLUGIN_NAME) {
    return { ok: false, reason: `manifest names "${manifest?.name ?? 'nothing'}", not "${CE_PLUGIN_NAME}"` };
  }
  const skillNames = await readSkillNames(root, io);
  if (skillNames === undefined || skillNames.length === 0) {
    return { ok: false, reason: 'the checkout has no skills/ directory' };
  }
  return { ok: true, path: root, version: String(manifest.version ?? 'unknown'), skillNames };
}

/**
 * The stable identity of one detected checkout plus this build's own exposure
 * surface. Recorded when a user links CE; re-derived on every probe.
 */
export function fingerprint(probe) {
  const payload = [probe.path, probe.version, probe.commitSha ?? 'no-commit', String(probe.skillCount), probe.allowlistDigest].join('\0');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * Probe every candidate root and describe the first real CE checkout found.
 *
 * @returns {Promise<object>} always a result object, never a throw: a failed
 *   probe is information the settings card must render, not an error.
 */
export async function probeCe(options = {}, io = defaultIo) {
  const now = options.now ?? Date.now();
  const home = options.home ?? homedir();
  const installed = options.installed ?? await readInstalledPlugins(home, io);
  const roots = candidateRoots({ cePath: options.cePath, home, installed });
  const tried = [];
  for (const candidate of roots) {
    const found = await inspectRoot(candidate.path, io);
    if (!found.ok) {
      tried.push(`${candidate.source}: ${candidate.path} — ${found.reason}`);
      continue;
    }
    const skillCount = found.skillNames.length;
    const probe = {
      status: 'found',
      source: candidate.source,
      path: found.path,
      version: found.version,
      commitSha: await readCommitSha(found.path, io),
      skillCount,
      allowlistDigest: allowlistDigest(),
      // A skill count that no longer matches the reviewed release means CE
      // added or removed something. Not an error and not a block — the
      // allowlist is closed, so nothing new is exposed either way — but the
      // human who owns that table should be told.
      reviewNeeded: skillCount !== CE_REVIEWED_SKILL_COUNT || found.version !== CE_REVIEWED_VERSION,
      reviewedAgainst: { version: CE_REVIEWED_VERSION, skillCount: CE_REVIEWED_SKILL_COUNT },
      probedAt: now,
      tried,
    };
    return { ...probe, fingerprint: fingerprint(probe) };
  }
  return {
    status: 'not-found',
    probedAt: now,
    tried,
    allowlistDigest: allowlistDigest(),
    reason: roots.length === 0
      ? 'no candidate root to inspect'
      : 'no Compound Engineering checkout at any candidate root — install it yourself, then probe again (this plugin never downloads it)',
  };
}

/** One line for the settings card and any log that needs to say what happened. */
export function probeSummary(probe) {
  if (probe?.status !== 'found') {
    return `not detected — ${probe?.reason ?? 'no probe has run yet'}`;
  }
  return `detected v${probe.version} at ${probe.path} (${probe.skillCount} skills, ${probe.commitSha ? probe.commitSha.slice(0, 7) : 'no commit'})`
    + `${probe.reviewNeeded ? ' — differs from the reviewed release, the allowlist needs a human pass' : ''}`;
}
