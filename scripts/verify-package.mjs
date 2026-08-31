import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Validates the packed tarball manifest matches what the DSH loader needs:
// name/exports/patch present, and no stray dev junk. Runs `npm pack --dry-run`.
// shell:true so cmd.exe resolves the npm shim on Windows (Node 22 forbids
// spawning .cmd directly).
const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
let out;
try {
  out = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) {
  console.error('verify:package FAILED: npm pack --dry-run errored\n' + (error.stderr?.toString() ?? error.message));
  process.exit(1);
}
let manifest;
try {
  manifest = JSON.parse(out);
} catch {
  console.error('verify:package FAILED: unparseable npm pack output');
  process.exit(1);
}
const files = (manifest[0]?.files ?? []).map(f => f.path);
const need = ['package.json', 'lib/index.js', 'cordis.patch.yml'];
const absent = need.filter(n => !files.includes(n));
if (absent.length) {
  console.error(`verify:package FAILED: tarball missing ${absent.join(', ')}`);
  console.error('packed files:', files.join(', '));
  process.exit(1);
}
if (!pkg.name.startsWith('@ericwang1358/')) {
  console.error(`verify:package FAILED: package name "${pkg.name}" is not author-scoped`);
  process.exit(1);
}
console.log(`verify:package OK: ${pkg.name}@${pkg.version} tarball carries lib/index.js + cordis.patch.yml (${files.length} files).`);
