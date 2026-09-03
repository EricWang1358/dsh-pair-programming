import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(d) {
  let out = [];
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    const st = statSync(p);
    if (st.isDirectory()) out = out.concat(walk(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
const declared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
]);
const meta = pkg.peerDependenciesMeta ?? {};

const runtime = new Map();
const typeOnly = new Map();
for (const f of walk('lib')) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/import([^;]*?)from\s*['"](@deepseek-ai\/[^'"]+|schemastery)['"]/g)) {
    const clause = m[1];
    const spec = m[2];
    const isTypeOnly = /^\s*type\s/.test(clause) || /import\s+type\b/.test(m[0]);
    const bucket = isTypeOnly ? typeOnly : runtime;
    if (!bucket.has(spec)) bucket.set(spec, new Set());
    bucket.get(spec).add(f);
  }
  // namespace/require forms without 'from' (none expected, but catch bare)
}

console.log('=== runtime (value) imports ===');
let problems = [];
for (const [spec, files] of [...runtime].sort()) {
  const covered = declared.has(spec);
  const peerOptional = (pkg.peerDependencies ?? {})[spec] && meta[spec]?.optional;
  console.log(`${covered ? 'OK ' : 'MISSING'} ${spec.padEnd(34)} files=${[...files].map(x => x.replace(/\\/g, '/')).join(', ')}${peerOptional ? '  [marked OPTIONAL]' : ''}`);
  if (!covered) problems.push(`not declared: ${spec}`);
  else if (peerOptional) problems.push(`optional peer but runtime-imported: ${spec}`);
}

console.log('\n=== type-only imports (may stay optional peer / devDep) ===');
for (const [spec, files] of [...typeOnly].sort()) {
  console.log(`${declared.has(spec) ? 'OK ' : 'note'} ${spec.padEnd(34)} files=${[...files].map(x => x.replace(/\\/g, '/')).join(', ')}`);
}

if (problems.length) {
  console.error('\nRUNTIME-IMPORT GATE FAILED:');
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}
console.log('\nRUNTIME-IMPORT GATE PASSED: every value import is covered by a required dependency or peer.');
