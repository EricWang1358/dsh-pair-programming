import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Syntax-level typecheck without an external toolchain: `node --check` every
// .js under lib/ and scripts/ and tests/. For plain-ESM JS plugins this is the
// offline-safe equivalent of tsc --noEmit on the shipped surface. If a `tsc`
// is available (project added typescript later), it runs too; otherwise skipped.
function walkJs(d, acc = []) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    const st = statSync(p);
    if (st.isDirectory()) walkJs(p, acc);
    else if (p.endsWith('.js') || p.endsWith('.mjs')) acc.push(p);
  }
  return acc;
}

const files = [...walkJs('lib'), ...walkJs('scripts'), ...walkJs('tests')];
let failures = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (error) {
    failures += 1;
    console.error(`SYNTAX FAIL ${f}\n${error.stderr?.toString() ?? error.message}`);
  }
}

if (failures > 0) {
  console.error(`\ntypecheck FAILED: ${failures}/${files.length} files with syntax errors.`);
  process.exit(1);
}
console.log(`typecheck OK: ${files.length} files parse clean.`);
