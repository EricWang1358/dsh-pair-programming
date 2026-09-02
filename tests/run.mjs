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
const suites = ['protocol.test.mjs', 'state.test.mjs', 'lock.test.mjs', 'gate.test.mjs', 'story.test.mjs', 'settings.test.mjs', 'client.test.mjs', 'members.test.mjs', 'lifecycle.test.mjs', 'lifecycle-output.test.mjs', 'collapse.test.mjs'];
for (const s of suites) {
  const mod = await import(new URL(`./${s}`, import.meta.url).href);
  await mod.run(check);
}

if (results.length) {
  console.error(results.join('\n'));
}
console.log(`\n${pass} passed, ${fail} failed across ${suites.length} suites.`);
process.exit(fail === 0 ? 0 : 1);
