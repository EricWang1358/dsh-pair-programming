import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Syntax-level typecheck without an external toolchain: `node --check` every
// .js under lib/ and scripts/ and tests/. This checks syntax only, not types.
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
let unavailable = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOENT'].includes(error.code)) {
      unavailable += 1;
      console.error(`SKIPPED (spawn blocked) ${f}: ${error.code}`);
      continue;
    }
    failures += 1;
    console.error(`SYNTAX FAIL ${f}\n${error.stderr?.toString() ?? error.message}`);
  }
}

if (unavailable > 0) {
  console.error(`typecheck incomplete: ${unavailable} checks could not run.`);
}
if (failures > 0) {
  console.error(`\ntypecheck FAILED: ${failures}/${files.length} files with syntax errors.`);
  process.exit(1);
}
if (unavailable > 0) process.exit(1);
console.log(`typecheck OK: ${files.length} files parse clean.`);
