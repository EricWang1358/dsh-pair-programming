import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// This runner exits its process and loads suites that patch process-local APIs.
// Refuse in-host import BEFORE any suite or exit call can affect DSH.
if (!process.argv[1] || realpathSync(process.argv[1]) !== realpathSync(fileURLToPath(import.meta.url))) {
  throw new Error('PAIR_TEST_PROCESS_REQUIRED: run node tests/run.mjs in a separate process; never import the runner into DSH');
}

/**
 * Test runner: aggregates the pure-logic unit suites. Offline, no deps.
 * Exits nonzero on any failure so `pnpm test` gates the pipeline.
 */
let pass = 0, fail = 0, skipped = 0;
const results = [];
const skippedReasons = [];
const skippedNames = [];
function check(cond, name) {
  if (cond) { pass += 1; }
  else { fail += 1; results.push(`FAIL: ${name}`); }
}
// A suite that cannot exercise what it asserts must SAY so. Reporting a deliberate
// omission as a pass is the false-green the review named: the count hides it, and a
// 'no-op outside a prepared checkout' reads exactly like a verified claim. Recorded,
// printed, and fatal unless --allow-skips says the omission is expected here.
check.skip = (name, reason) => { skipped += 1; skippedNames.push(name); skippedReasons.push(`SKIP: ${name} — ${reason}`); };

// Running ONE suite is the normal case while iterating, and paying for all 49 is
// how a five-line change costs eight minutes: the expensive suites are expensive
// because they spawn real git processes and mount the real SDK
// (integration.test.mjs alone measured 115-133s for 7 checks), not because they
// assert a lot. So:
//
//   node tests/run.mjs                     every suite (the release gate)
//   node tests/run.mjs --only gate,scope   just those, matched by substring
//   node tests/run.mjs --timing            print how long each suite took
//
// A closed list is still the contract: --only can only NARROW it, so a suite
// that is never registered is never silently skipped from the full run.
const argv = process.argv.slice(2);
const onlyAt = argv.indexOf('--only');
const only = onlyAt === -1 ? undefined
  : String(argv[onlyAt + 1] ?? '').split(',').map(v => v.trim()).filter(Boolean);
// --skip name[,name]: run everything EXCEPT these. The companion to --only for a run that has a
// genuinely missing input rather than a narrowed question. Measured need: tests/ledger.test.mjs
// guards the 65KB project ledger that lives BESIDE this package in the development workspace, so a
// clean checkout - what CI has - cannot read it and reports an unexpected skip. Like --only,
// a word that matches nothing is refused: a filter that shrinks the run silently is the defect
// K2-1 already fixed for --only, and a second filter must not reintroduce it.
const skipAt = argv.indexOf('--skip');
const skip = skipAt === -1 ? undefined
  : String(argv[skipAt + 1] ?? '').split(',').map(v => v.trim()).filter(Boolean);
const timing = argv.includes('--timing');
// --parallel N: run each selected suite in its OWN process, N at a time. The suites are
// single-process and sequential by construction, so the long ones (worktrees ~4min,
// verification ~2min) used to be pure wall-clock. Each child prints its own summary; this
// parent aggregates the counts and the exit codes and never runs a suite itself.
// Skips are fatal by default: an environment that cannot run a check has not verified it.
const allowSkips = argv.includes('--allow-skips');
// The baseline names the skips THIS environment is allowed to have. Loud-and-counted is
// not enough on its own: with the gate acknowledging the old gap, a suite that quietly
// stops checking something new would pass. Compared by suite + name; an entry that no
// longer skips is reported as stale, because that means the check runs again.
let skipBaseline = {};
try { skipBaseline = JSON.parse(readFileSync(new URL('./skip-baseline.json', import.meta.url), 'utf8')); } catch { skipBaseline = {}; }
const unexpectedSkips = [];
const staleBaseline = [];
const parallelAt = argv.indexOf('--parallel');
const parallel = parallelAt === -1 ? 1 : Math.max(1, Math.min(16, Number(argv[parallelAt + 1] ?? 2) || 2));
if (onlyAt !== -1 && (only === undefined || only.length === 0)) {
  console.error('--only needs a comma-separated list of suite names, e.g. --only gate,scope');
  process.exit(2);
}
// K2-1: the filter must not be able to lie. An unknown flag is refused rather than
// ignored, and EVERY word of --only has to match something - the measured defect was a
// typo in a second word that silently ran fewer suites while the run still read green.
const KNOWN_FLAGS = ['--only', '--skip', '--timing', '--parallel', '--allow-skips'];
for (const token of argv) {
  if (token.startsWith('--') && !KNOWN_FLAGS.includes(token)) {
    console.error('unknown flag ' + token + '; known flags: ' + KNOWN_FLAGS.join(', '));
    process.exit(2);
  }
}

// Interrupted runs skip their fixture's finally block, so our own temp debris accumulates
// (measured: 361 directories). Sweep OUR stale ones once, in the parent only - a parallel
// child always runs with --only and would race every other child. Best effort: a sweep
// failure never fails a test run, and the numbers are printed rather than asserted.
if (only === undefined) {
  const { sweepStaleFixtures } = await import('./support/tmp-sweep.mjs');
  try {
    const swept = await sweepStaleFixtures();
    if (swept.removed.length > 0 || swept.kept.length > 0) {
      console.log(`temp fixtures: removed ${swept.removed.length} stale, kept ${swept.kept.length} (prefix + age scoped)`);
    }
  } catch (error) { console.log('temp fixture sweep skipped: ' + String(error.message)); }
}

// Each suite exports an async run(check) so state is isolated.
const suites = ['peer-setup.test.mjs', 'protocol.test.mjs', 'state.test.mjs', 'lock.test.mjs', 'gate.test.mjs', 'story.test.mjs', 'coverage.test.mjs', 'settings.test.mjs', 'client.test.mjs', 'members.test.mjs', 'lifecycle.test.mjs', 'lifecycle-output.test.mjs', 'collapse.test.mjs', 'wake.test.mjs', 'oracle.test.mjs', 'obligation.test.mjs', 'scope.test.mjs', 'stall.test.mjs', 'solo.test.mjs', 'board-guard.test.mjs', 'task-amend.test.mjs', 'disclosure.test.mjs', 'attention.test.mjs', 'ce.test.mjs', 'lessons.test.mjs', 'command.test.mjs', 'ce-registry.test.mjs', 'events.test.mjs', 'host-contract.test.mjs', 'command-shape.test.mjs', 'nav-model.test.mjs', 'ledger.test.mjs', 'settings-host.test.mjs'];
suites.push('stability.test.mjs');
suites.push('drift.test.mjs');
suites.push('delivery.test.mjs');
suites.push('verification.test.mjs');
suites.push('worktrees.test.mjs', 'isolated-members.test.mjs', 'parallel-tasks.test.mjs', 'integration.test.mjs', 'dual-lifecycle.test.mjs');
suites.push('product.test.mjs', 'backlog.test.mjs', 'repair.test.mjs', 'design.test.mjs');
suites.push('panel.test.mjs', 'deliverables.test.mjs');
suites.push('yield.test.mjs');
suites.push('quality-guards.test.mjs');
suites.push('prompt-budget.test.mjs');
suites.push('cleanup.test.mjs');
suites.push('tmp-sweep.test.mjs');
suites.push('gate-binding.test.mjs');
// U1's acceptance suite: ported from the oracle frozen by the v15-u1-routing Navigator
// before any implementation existed (see the file header for the two instrument repairs).
suites.push('route-isolation.test.mjs');
// J1's directed filesystem regression: the runtime-input seed may not follow a link
// on any ancestor of a declared path, in either direction.
suites.push('runtime-input-boundary.test.mjs');
// J2's directed scheduler regression: one board owns a checkout, and a loaded-session
// test cannot see the board that a restart left on disk.
suites.push('workspace-ownership.test.mjs');
if (skipAt !== -1 && (skip === undefined || skip.length === 0)) {
  console.error('--skip needs a comma-separated list of suite names, e.g. --skip ledger');
  process.exit(2);
}
const selected = (only === undefined ? suites : suites.filter(s => only.some(needle => s.includes(needle))))
  .filter(s => skip === undefined || !skip.some(needle => s.includes(needle)));
if (skip !== undefined) {
  const unmatchedSkip = skip.filter(word => !suites.some(name => name.includes(word)));
  if (unmatchedSkip.length > 0) {
    console.error('--skip matched no suite for: ' + unmatchedSkip.join(', ') + ' — a word that excludes nothing must fail, not shrink the run silently');
    process.exit(2);
  }
  if (selected.length === 0) { console.error('--skip excluded every suite; there is nothing left to run'); process.exit(2); }
}
if (only !== undefined) {
  const unmatched = only.filter(word => !suites.some(name => name.includes(word)));
  if (unmatched.length > 0) {
    console.error('--only matched no suite for: ' + unmatched.join(', ') + ' — a word that selects nothing must fail, not shrink the run silently');
    console.error('known suites: ' + suites.join(', '));
    process.exit(2);
  }
  if (selected.length === 0) { console.error('--only selected nothing. Known suites: ' + suites.join(', ')); process.exit(2); }
}
if (parallel > 1) {
  const { spawn } = await import('node:child_process');
  const self = fileURLToPath(import.meta.url);
  const summary = /(\d+) passed, (\d+) failed, (\d+) skipped/;
  const outcomes = [];
  const queue = [...selected];
  await new Promise(resolve => {
    let active = 0, done = 0;
    const pump = () => {
      while (active < parallel && queue.length > 0) {
        const suite = queue.shift();
        active++;
        const childAt = Date.now();
        // The child gets the acknowledgement too. It was dropped until now, so a suite whose only
        // skip is an acknowledged environment gap (host-contract's prompt render, the J1 symlink)
        // exited 1 under --parallel and 0 without it - the same suite, two verdicts, decided by
        // whether the runner itself was parallel. Measured on CI, where the assertEventsSupported
        // render check cannot run and host-contract failed with 46 passed / 0 failed / 1 skipped.
        const childArgs = [self, '--only', suite, ...(allowSkips ? ['--allow-skips'] : [])];
        const child = spawn(process.execPath, childArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', chunk => { out += String(chunk); });
        child.stderr.on('data', chunk => { out += String(chunk); });
        child.on('close', code => {
          active--; done++;
          // Keep the failing child's own words. The summary line names the suite and its counts,
          // and until this existed the assertion text was thrown away - which turned a runner-only
          // failure into a hunt for whichever check it was. Off by default so a green run stays
          // quiet; PAIR_TEST_VERBOSE=1 (what CI sets) prints the tail of every broken suite.
          if (code !== 0 && process.env.PAIR_TEST_VERBOSE === '1') {
            const tail = out.trimEnd().split(String.fromCharCode(10)).slice(-20).join(String.fromCharCode(10));
            console.error('--- ' + suite + ' output (last 20 lines) ---' + String.fromCharCode(10) + tail);
          }
          const match = summary.exec(out);
          const ms = Date.now() - childAt;
          outcomes.push({ suite, code, ms, passed: match ? Number(match[1]) : 0, failed: match ? Number(match[2]) : (code === 0 ? 0 : 1), skipped: match ? Number(match[3]) : 0 });
          // Per-suite wall clock in parallel mode too: K2-3 asks what the heavy suites
          // actually cost, and until this existed the only way to find out was to run them
          // one at a time, which is the cost being measured.
          console.log('  ' + suite + ': ' + (ms / 1000).toFixed(1) + 's (exit ' + String(code) + ')');
          if (done === selected.length) resolve(); else pump();
        });
      }
    };
    pump();
  });
  const passed = outcomes.reduce((sum, row) => sum + row.passed, 0);
  const failed = outcomes.reduce((sum, row) => sum + row.failed, 0);
  const skippedParallel = outcomes.reduce((sum, row) => sum + row.skipped, 0);
  const broken = outcomes.filter(row => row.code !== 0);
  if (broken.length > 0) console.error(broken.map(row => 'FAILED ' + row.suite + ': ' + row.passed + ' passed / ' + row.failed + ' failed (exit ' + String(row.code) + ')').join(String.fromCharCode(10)));
  const slowest = [...outcomes].sort((a, b) => b.ms - a.ms).slice(0, 10);
  console.log('slowest: ' + slowest.map(row => row.suite + ' ' + (row.ms / 1000).toFixed(1) + 's').join(' · '));
  console.log(String.fromCharCode(10) + passed + ' passed, ' + failed + ' failed, ' + skippedParallel + ' skipped across ' + selected.length + ' suites (parallel ' + parallel + ')');
  if (skippedParallel > 0 && !allowSkips) console.error('a skipped check is not a verified one; re-run with --allow-skips only when the environment genuinely cannot exercise it');
  process.exit(broken.length === 0 && failed === 0 && (skippedParallel === 0 || allowSkips) ? 0 : 1);
}
const timings = [];
for (const s of selected) {
  const startedAt = Date.now();
  if (timing) console.log(`START ${s} (${timings.length + 1}/${selected.length})`);
  const mod = await import(new URL(`./${s}`, import.meta.url).href);
  const before = { pass, fail, skipped, names: skippedNames.length };
  await mod.run(check);
  // Per-suite counts, always: a suite that silently omits half its assertions is visible
  // here as a number that fell, years before anyone notices the claim it stopped checking.
  console.log(`  ${s}: ${pass - before.pass} passed, ${fail - before.fail} failed, ${skipped - before.skipped} skipped`);
  const suiteSkips = skippedNames.slice(before.names);
  const expectedSkips = Array.isArray(skipBaseline[s]) ? skipBaseline[s] : [];
  for (const name of suiteSkips) if (!expectedSkips.includes(name)) unexpectedSkips.push(s + ' :: ' + name);
  for (const name of expectedSkips) if (!suiteSkips.includes(name)) staleBaseline.push(s + ' :: ' + name);
  if (typeof mod.runBaton === 'function') await mod.runBaton(check);
  const ms = Date.now() - startedAt;
  timings.push({ suite: s, ms });
  if (timing) console.log(`  ${(ms / 1000).toFixed(1)}s  ${s}`);
}
if (timing) {
  const slowest = [...timings].sort((a, b) => b.ms - a.ms).slice(0, 8);
  const total = timings.reduce((sum, row) => sum + row.ms, 0);
  console.log(`\nslowest: ${slowest.map(row => `${row.suite} ${(row.ms / 1000).toFixed(1)}s`).join(' · ')}`);
  console.log(`suite time: ${(total / 1000).toFixed(1)}s`);
}

if (results.length) {
  console.error(results.join('\n'));
}
if (skippedReasons.length > 0) {
  console.error(skippedReasons.join('\n'));
  if (!allowSkips) console.error('a skipped check is not a verified one; re-run with --allow-skips only when the environment genuinely cannot exercise it');
}
if (unexpectedSkips.length > 0) {
  console.error('UNEXPECTED SKIPS — not in tests/skip-baseline.json:');
  for (const row of unexpectedSkips) console.error('  ' + row);
  console.error('a new skip is a check that stopped being verified: fix it, or add it to the baseline in the SAME commit with its reason');
}
if (staleBaseline.length > 0) {
  console.error('stale baseline entries — these run again now, so remove them from tests/skip-baseline.json:');
  for (const row of staleBaseline) console.error('  ' + row);
}
console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped across ${(only === undefined ? suites : selected).length} suites${only === undefined ? '' : ' (filtered by --only: ' + selected.join(',') + ')'}.`);
process.exit(fail === 0 && unexpectedSkips.length === 0 && (skipped === 0 || allowSkips) ? 0 : 1);
