/**
 * Test runner: aggregates the pure-logic unit suites. Offline, no deps.
 * Exits nonzero on any failure so `pnpm test` gates the pipeline.
 */
let pass = 0, fail = 0;
const results = [];
function check(cond, name) {
  if (cond) { pass += 1; }
  else { fail += 1; results.push(`FAIL: ${name}`); }
}

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
const timing = argv.includes('--timing');
if (onlyAt !== -1 && (only === undefined || only.length === 0)) {
  console.error('--only needs a comma-separated list of suite names, e.g. --only gate,scope');
  process.exit(2);
}

// Each suite exports an async run(check) so state is isolated.
const suites = ['protocol.test.mjs', 'state.test.mjs', 'lock.test.mjs', 'gate.test.mjs', 'story.test.mjs', 'coverage.test.mjs', 'settings.test.mjs', 'client.test.mjs', 'members.test.mjs', 'lifecycle.test.mjs', 'lifecycle-output.test.mjs', 'collapse.test.mjs', 'wake.test.mjs', 'oracle.test.mjs', 'obligation.test.mjs', 'scope.test.mjs', 'stall.test.mjs', 'solo.test.mjs', 'board-guard.test.mjs', 'task-amend.test.mjs', 'disclosure.test.mjs', 'attention.test.mjs', 'ce.test.mjs', 'lessons.test.mjs', 'command.test.mjs', 'ce-registry.test.mjs', 'events.test.mjs', 'host-contract.test.mjs', 'command-shape.test.mjs', 'nav-model.test.mjs', 'ledger.test.mjs', 'settings-host.test.mjs'];
suites.push('stability.test.mjs');
suites.push('drift.test.mjs');
suites.push('delivery.test.mjs');
suites.push('verification.test.mjs');
suites.push('worktrees.test.mjs', 'isolated-members.test.mjs', 'parallel-tasks.test.mjs', 'integration.test.mjs', 'dual-lifecycle.test.mjs');
suites.push('product.test.mjs', 'backlog.test.mjs', 'repair.test.mjs', 'design.test.mjs');
suites.push('panel.test.mjs', 'deliverables.test.mjs');
suites.push('yield.test.mjs');
suites.push('gate-binding.test.mjs');
const selected = only === undefined ? suites
  : suites.filter(s => only.some(needle => s.includes(needle)));
if (only !== undefined && selected.length === 0) {
  console.error(`--only matched no suite. Known suites: ${suites.join(', ')}`);
  process.exit(2);
}
const timings = [];
for (const s of selected) {
  const startedAt = Date.now();
  const mod = await import(new URL(`./${s}`, import.meta.url).href);
  await mod.run(check);
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
console.log(`\n${pass} passed, ${fail} failed across ${(only === undefined ? suites : selected).length} suites${only === undefined ? '' : ' (filtered by --only)'}.`);
process.exit(fail === 0 ? 0 : 1);
