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

// Each suite exports an async run(check) so state is isolated.
const suites = ['protocol.test.mjs', 'state.test.mjs', 'lock.test.mjs', 'gate.test.mjs', 'story.test.mjs', 'coverage.test.mjs', 'settings.test.mjs', 'client.test.mjs', 'members.test.mjs', 'lifecycle.test.mjs', 'lifecycle-output.test.mjs', 'collapse.test.mjs', 'wake.test.mjs', 'oracle.test.mjs', 'obligation.test.mjs', 'scope.test.mjs', 'stall.test.mjs', 'solo.test.mjs', 'board-guard.test.mjs', 'task-amend.test.mjs', 'disclosure.test.mjs', 'attention.test.mjs', 'ce.test.mjs', 'lessons.test.mjs', 'command.test.mjs', 'ce-registry.test.mjs', 'events.test.mjs', 'host-contract.test.mjs', 'command-shape.test.mjs', 'nav-model.test.mjs', 'ledger.test.mjs', 'settings-host.test.mjs'];
suites.push('stability.test.mjs');
suites.push('drift.test.mjs');
suites.push('delivery.test.mjs');
for (const s of suites) {
  const mod = await import(new URL(`./${s}`, import.meta.url).href);
  await mod.run(check);
  if (typeof mod.runBaton === 'function') await mod.runBaton(check);
}

if (results.length) {
  console.error(results.join('\n'));
}
console.log(`\n${pass} passed, ${fail} failed across ${suites.length} suites.`);
process.exit(fail === 0 ? 0 : 1);
