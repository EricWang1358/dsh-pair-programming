import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

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
// K2-4: one Node process per file is inherent to `node --check`, but running them
// SEQUENTIALLY made the daily check pay ~13s for 149 files. A bounded pool keeps the same
// coverage and the same per-file verdict; only the wall clock changes. The timeout turns a
// stuck process into a failure instead of a stuck check.
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.TYPECHECK_CONCURRENCY ?? 8) || 8));
const queue = [...files];
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
  for (;;) {
    const f = queue.shift();
    if (f === undefined) return;
    try {
      await execFileP(process.execPath, ['--check', f], { timeout: 60_000 });
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
}));

if (unavailable > 0) {
  console.error(`typecheck incomplete: ${unavailable} checks could not run.`);
}
if (failures > 0) {
  console.error(`\ntypecheck FAILED: ${failures}/${files.length} files with syntax errors.`);
  process.exit(1);
}
if (unavailable > 0) process.exit(1);
console.log(`typecheck OK: ${files.length} files parse clean.`);
