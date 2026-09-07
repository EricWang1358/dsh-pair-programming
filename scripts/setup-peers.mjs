import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Provision the plugin's own `node_modules/@deepseek-ai` so a `link:`-ed copy
 * resolves its runtime peers from its REAL path. Node walks up from the plugin
 * source dir, not the profile, so a linked plugin does NOT borrow the profile's
 * hoisted peers — a real `dsh --profile` boot fails with ERR_MODULE_NOT_FOUND
 * without this (that is exactly the failure this plugin hit in a live boot).
 *
 * Prefer `pnpm install` (real copies). When the peer packages are not separately
 * fetchable (they ship inside the installed DSH app), fall back to a junction
 * pointing at the DSH built-in `@deepseek-ai` — the SAME physical modules
 * `dsh-base` uses, preserving singleton identity (defineTool / brand helpers).
 *
 * Idempotent. Wire as `prepare`; safe to re-run.
 */

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const peerNM = join(pluginRoot, 'node_modules');
const junctionTarget = join(peerNM, '@deepseek-ai');

function entryExists(path) {
  try { lstatSync(path); return true; } catch { return false; }
}

const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
const peers = Object.keys({ ...(pkg.peerDependencies ?? {}), ...(pkg.dependencies ?? {}) })
  .filter(n => n.startsWith('@deepseek-ai/'))
  .map(n => n.slice('@deepseek-ai/'.length));

/** Locate the installed DSH app's own @deepseek-ai singleton tree. */
function locateDshSdk() {
  const candidates = [];
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    const bin = execFileSync(probe, ['dsh'],
      { encoding: 'utf8', shell: process.platform === 'win32' }).trim().split(/\r?\n/)[0] ?? '';
    if (bin !== '') {
      // Follow symlinks to the REAL entry (nvm: bin/dsh -> lib/node_modules/
      // @deepseek-ai/dsh/bin/dsh.js — the old code stripped the suffix off the
      // LINK path and looked in bin/node_modules, which nvm never populates),
      // then climb every ancestor looking for the host's peer tree.
      let real = bin;
      try { real = realpathSync(bin); } catch { /* plain file, not a link */ }
      let dir = join(real, '..');
      while (true) {
        candidates.push(join(dir, 'node_modules'));
        const parent = join(dir, '..');
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch { /* where/which failed */ }
  try {
    candidates.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim());
  } catch { /* npm absent — pnpm-only machines */ }
  const fallbacks = [
    'D:/Program Files/nodejs/node_global/node_modules',
    'D:/Program Files/nodejs/node_global/node_modules/@deepseek-ai/dsh/node_modules',
  ];
  for (const base of [...candidates, ...fallbacks]) {
    const cand = join(base, '@deepseek-ai');
    if (existsSync(join(cand, 'dsh-tools', 'package.json'))) return cand;
  }
  return undefined;
}

// 1. If peers already resolve (e.g. a real pnpm install populated them), done.
const sdk = locateDshSdk();
let pointsAtSdk = false;
if (entryExists(junctionTarget) && sdk !== undefined) {
  try { pointsAtSdk = realpathSync(junctionTarget) === realpathSync(sdk); } catch { /* stale link */ }
}
if (pointsAtSdk && peers.every(p => existsSync(join(junctionTarget, p, 'package.json')))) {
  console.log('setup:peers OK: node_modules/@deepseek-ai already resolves all peers.');
  process.exit(0);
}

// 2. Fall back to a junction at the DSH built-in @deepseek-ai.
if (!sdk) {
  console.error('setup:peers FAILED: no installed @deepseek-ai SDK found. Run `pnpm install` or ensure DSH is installed.');
  process.exit(1);
}
mkdirSync(peerNM, { recursive: true });
if (entryExists(junctionTarget)) {
  try { rmSync(junctionTarget, { force: true, recursive: true }); } catch { /* ignore */ }
}
  // Windows junctions want backslash separators; everywhere else the native
  // forward-slash path is the only valid one (a backslash link is dangling).
  const linkTarget = process.platform === 'win32' ? sdk.replace(/\//g, '\\') : sdk;
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(linkTarget, junctionTarget, linkType);
const missing = peers.filter(p => !existsSync(join(junctionTarget, p, 'package.json')));
if (missing.length) {
  console.error(`setup:peers FAILED: junction to ${sdk} missing peers: ${missing.join(', ')}.`);
  process.exit(1);
}
console.log(`setup:peers OK: node_modules/@deepseek-ai -> ${sdk} (singleton with dsh-base); peers resolvable from the plugin real path.`);
