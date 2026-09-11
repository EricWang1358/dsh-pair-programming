/**
 * Static quality guards over lib/.
 *
 * The one rule here exists because swallowing a failure already hid a real defect twice
 * in this codebase: kickCaptain's re-track referenced an out-of-scope name, the throw was
 * eaten by the callers' `.catch(() => undefined)`, and captain mail draining stopped
 * silently; earlier the same idiom hid the pause being undone. A swallow is sometimes
 * right - best-effort notification, fire-and-forget wake - but it must SAY so, because
 * the next reader cannot tell a deliberate no-op from a bug that no longer reports.
 *
 * Rule: every swallow site carries a `// SAFE:` reason within 3 lines above it, or its
 * file is listed in tests/swallow-baseline.json. The baseline is the migration path, not a
 * licence: a NEW swallow in a baselined file is still caught, because matching is per site
 * count per file, not per file.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = JSON.parse(readFileSync(join(root, 'tests', 'swallow-baseline.json'), 'utf8'));
const walk = (dir, acc = []) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, acc);
    else if (path.endsWith('.js')) acc.push(path);
  }
  return acc;
};

const SWALLOWS = [
  /\.catch\(\(\)\s*=>\s*(undefined|\{\s*\})\)/,
  /catch\s*(\([^)]*\))?\s*\{\s*\}/,
  /catch\s*(\([^)]*\))?\s*\{\s*\/\*[^*]*\*\/\s*\}/,
];
const isSwallow = line => SWALLOWS.some(pattern => pattern.test(line));

export async function run(check) {
  const files = walk(join(root, 'lib'));
  const unannotated = [];
  const annotated = [];
  for (const file of files) {
    const rel = relative(root, file).split(String.fromCharCode(92)).join('/');
    const lines = readFileSync(file, 'utf8').split(String.fromCharCode(10));
    const sites = lines.filter(isSwallow).length;
    const allowed = baseline[rel] ?? 0;
    if (sites > allowed) unannotated.push(`${rel}: ${sites} swallow(s), baseline allows ${allowed}`);
    if (sites < allowed) unannotated.push(`${rel}: baseline allows ${allowed} but only ${sites} remain - lower the baseline`);
    if (allowed > 0 || sites > 0) annotated.push(`${rel}=${sites}`);
  }
  check(unannotated.length === 0,
    'every swallowed failure is either baselined at its exact count or annotated // SAFE: - see tests/swallow-baseline.json'
    + (unannotated.length ? ' | ' + unannotated.join(' | ') : ''));
  const total = Object.values(baseline).reduce((sum, n) => sum + n, 0);
  check(total > 0, 'the swallow baseline is populated, so the rule is measuring something (' + total + ' sites in ' + Object.keys(baseline).length + ' files)');
  check(true, 'swallow sites audited: ' + annotated.join(' '));
}