/**
 * Process audit: the checks this project keeps having to redo by hand.
 *
 * Each one exists because the class it screens produced a real defect here:
 *  - a kick whose first argument was a stateRoot instead of a workspace silently disabled
 *    wake-ups (F4), because kickTeam resolves the state root from the workspace itself;
 *  - a write outside the lock lost an update (M14'), because every writer assumes the lock
 *    actually serialised it;
 *  - a module no test touches is where the next defect waits.
 *
 * Two blind spots are handled explicitly, both of which produced a false reading before:
 * calls through optional chaining (`kickTeam?.(…)`) and writes behind a helper that takes
 * the lock itself (`commitMemberReplacement`).
 *
 * Usage: node scripts/process-audit.mjs [repoRoot]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url));
const sep = String.fromCharCode(92);
const walk = (dir, acc = []) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, acc);
    else if (/\.m?js$/.test(path)) acc.push(path);
  }
  return acc;
};
const rel = path => relative(root, path).split(sep).join('/');
const read = path => readFileSync(path, 'utf8').split(String.fromCharCode(10));
const problems = [];

/* ---- 1. every kick/delivery site passes a workspace ------------------------ */
const KICK = /(?:kickTeam|kickMember)\s*\??\.?\s*\(/
for (const file of walk(join(root, 'lib'))) {
  read(file).forEach((line, index) => {
    if (!KICK.test(line)) return;
    if (/async kick(Team|Member)\(/.test(line)) return;
    // Take the argument after THIS call's parenthesis, not the first one on the line: a
    // kick inside `members.map(member => runtime.kickMember(workspace, ...))` otherwise reads
    // as `member => ...` and reports a false positive against correct code.
    const match = KICK.exec(line);
    const argument = line.slice((match?.index ?? 0) + (match?.[0].length ?? 0)).trim();
    if (!/^(workspaceOf\(|workspace\b|team\.parallel\.workspace)/.test(argument)) {
      problems.push(`${rel(file)}:${index + 1} kick does not start with a workspace: ${line.trim().slice(0, 80)}`);
    }
  });
}

/* ---- 2. every writeTeam is inside a lock ---------------------------------- */
// Brace-balanced enclosure rather than a line window: a window both misses a lock that
// opens further up and invents one that already closed (it produced eight false positives
// against correct code before this). The helper that takes the lock itself is allowed
// explicitly, because a textual scan cannot see inside it.
const LOCK_HELPERS = ['commitMemberReplacement'];
for (const file of walk(join(root, 'lib'))) {
  const lines = read(file);
  const lockedRanges = [];
  lines.forEach((text, start) => {
    if (!text.includes('withLock(')) return;
    let depth = 0, opened = false;
    for (let end = start; end < lines.length; end++) {
      for (const ch of lines[end]) { if (ch === '{') { depth += 1; opened = true; } else if (ch === '}') depth -= 1; }
      if (opened && depth <= 0) { lockedRanges.push([start, end]); break; }
    }
  });
  lines.forEach((line, index) => {
    if (!/\bwriteTeam\(/.test(line) || /export async function writeTeam/.test(line)) return;
    if (lockedRanges.some(([a, b]) => index >= a && index <= b)) return;
    const above = lines.slice(Math.max(0, index - 40), index).join(String.fromCharCode(10));
    if (LOCK_HELPERS.some(helper => above.includes(helper))) return;
    problems.push(`${rel(file)}:${index + 1} writeTeam outside a lock: ${line.trim().slice(0, 80)}`);
  });
}

/* ---- 3. a lib module no test references ---------------------------------- */
const tests = walk(join(root, 'tests')).map(file => readFileSync(file, 'utf8')).join(String.fromCharCode(10));
const orphan = [];
for (const file of walk(join(root, 'lib'))) {
  if (!file.endsWith('.js')) continue;
  const name = basename(file);
  if (!tests.includes('/' + name) && !tests.includes(name.replace(/\.js$/, ''))) orphan.push(rel(file));
}

/* ---- 4. swallowed failures (the count the guard baselines) ---------------- */
const SWALLOW = [
  /\.catch\(\(\)\s*=>\s*(undefined|\{\s*\})\)/,
  /catch\s*(\([^)]*\))?\s*\{\s*\}/,
  /catch\s*(\([^)]*\))?\s*\{\s*\/\*[^*]*\*\/\s*\}/,
];
let swallows = 0;
for (const file of walk(join(root, 'lib'))) swallows += read(file).filter(line => SWALLOW.some(p => p.test(line))).length;

console.log('process audit over ' + root);
console.log('  lib files:            ' + walk(join(root, 'lib')).filter(f => f.endsWith('.js')).length);
console.log('  kick sites checked:   ' + (walk(join(root, 'lib')).flatMap(read).filter(l => KICK.test(l)).length));
console.log('  swallowed failures:   ' + swallows + ' (see tests/swallow-baseline.json)');
console.log('  modules with no test: ' + (orphan.length === 0 ? 'none' : orphan.join(', ')));
if (problems.length > 0) {
  console.error(String.fromCharCode(10) + 'PROBLEMS:');
  for (const problem of problems) console.error('  ' + problem);
  process.exit(1);
}
console.log('  structural checks:    clean');
process.exit(0);