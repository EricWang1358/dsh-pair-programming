import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

// Plain-ESM plugin: nothing to transpile. "build" validates that the package
// surface the DSH loader needs actually exists and the exports map resolves —
// a real gate against a broken ship layout, not a no-op.
const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
const required = [pkg.main, pkg.types, 'cordis.patch.yml'].filter(Boolean);
const missing = required.filter(f => !existsSync(f));
if (missing.length) {
  console.error(`build FAILED: missing shipped files: ${missing.join(', ')}`);
  process.exit(1);
}
for (const exp of Object.values(pkg.exports ?? {})) {
  const target = typeof exp === 'string' ? exp : exp?.default;
  if (target && !existsSync(target)) {
    console.error(`build FAILED: exports target missing: ${target}`);
    process.exit(1);
  }
}
console.log(`build OK: main=${pkg.main}, types=${pkg.types}, patch=${pkg.dsh?.bundle?.patch}, exports resolve.`);
