/**
 * v3.2 loop-drive fixes derived from a 2h 16min live v3 run that produced zero
 * accepted increments: risk scopes, non-gating oracle arms, arbitration
 * budget attribution, and a freeze-count escape hatch.
 */
import { openRisk, blocksImplementation, blocksVerification, scopeOf } from '../lib/protocol/risks.js';
import { initialProtocolState, openCycle } from '../lib/protocol/machine.js';
import { forkProblems, freezeRecord, oracleSummary, nonGatingProblems } from '../lib/protocol/oracle.js';

const GOOD = {
  readings: ['reading a: the splitter must not break inside a brace quantifier', 'reading b: user escapes commas'],
  chosen_reading: 'reading a: the splitter must not break inside a brace quantifier',
  divergence_candidates: ['the hidden test may assert the unescaped form round-trips'],
  oracle_files: ['.pair-oracles/t-1/o.mjs'], oracle_cmd: 'node .pair-oracles/t-1/o.mjs',
};

export async function run(check) {
  /* ---- A: risk scopes route P0s to the right halt ------------------- */
  const p = initialProtocolState();
  const instrument = openRisk(p, { severity: 'P0', scenario: 'oracle self-certifies', trigger: 't', suggestion: 's', raisedBy: 'challenger', scope: 'instrument' });
  const product = openRisk(p, { severity: 'P0', scenario: 'white frame', trigger: 't', suggestion: 's', raisedBy: 'challenger', scope: 'product' });
  check(scopeOf(instrument) === 'instrument' && scopeOf(product) === 'product', 'A the scope is recorded on the ticket');
  check(scopeOf({}) === 'product', 'A a ticket without scope reads as product (safe default for pre-3.2 boards)');
  const productOnly = initialProtocolState();
  openRisk(productOnly, { severity: 'P0', scenario: 'x', trigger: 't', suggestion: 's', raisedBy: 'x', scope: 'instrument' });
  check(blocksImplementation(productOnly).length === 0, 'A THE session regression: an instrument-only P0 no longer holds implementation hostage');
  check(blocksVerification(productOnly).length === 1, 'A the same instrument P0 still refuses a verdict — measurement is what it makes untrustworthy');
  const both = initialProtocolState();
  openRisk(both, { severity: 'P0', scenario: 'x', trigger: 't', suggestion: 's', raisedBy: 'x', scope: 'instrument' });
  openRisk(both, { severity: 'P0', scenario: 'y', trigger: 't', suggestion: 's', raisedBy: 'x', scope: 'product' });
  check(blocksImplementation(both).length === 1 && blocksVerification(both).length === 2, 'A a product P0 keeps the old total block; the instrument one is added to verification only');

  /* ---- B: non-gating arms are first-class --------------------------- */
  check(nonGatingProblems({ non_gating_arms: [] }).length === 0, 'B declaring no non-gating arms is fine — this is the common path');
  check(nonGatingProblems({ non_gating_arms: ['a1'] })[0].includes('non_gating_reason'), 'B a blind spot with no reason is indistinguishable from moving a threshold');
  check(nonGatingProblems({ non_gating_arms: ['a1'], non_gating_reason: 'sensitive to composition; hard-gated on t-6' }).length === 0, 'B a stated reason lets the freeze proceed');
  const rec = freezeRecord({ ...GOOD, non_gating_arms: ['a1', 'a7'], non_gating_reason: 'covered by composition card' }, { sha: 'abcdef0123456789', run: { exit: 1 }, by: 'navigator', forks: 2 });
  check(rec.nonGating.length === 2 && rec.nonGatingReason.includes('composition'), 'B the freeze carries the arms and the reason');
  check(oracleSummary(rec).includes('2 declared non-gating arm(s)'), 'B the summary shows the declared blind spots wherever the oracle is displayed');
  check(oracleSummary(rec).includes('freeze #2'), 'B the summary shows the fork number so recursion is visible');

  /* ---- C: arbitration attribution follows the claimed task ---------- */
  // The pure-logic half; the fallback is in tools/arbitrate.js and is
  // exercised by inspection here (namesTask returns false for a ref that
  // spells 'the composition card' instead of 't-6').
  const { namesTask } = await import('../lib/protocol/machine.js');
  check(namesTask('the composition card', 't-6') === false, 'C THE session regression: a captain writing "the composition card" no longer avoids the budget by namesTask alone — the tool then falls back to the claimed task');
  check(namesTask('t-6 pre-freeze rulings', 't-6') === true, 'C an explicit id still attributes normally');

  /* ---- D: freeze budget shape ---------------------------------------- */
  const first = freezeRecord(GOOD, { sha: 'abcdef0123456789', run: { exit: 1 }, by: 'navigator', forks: 1 });
  check(first.forks === 1 && !oracleSummary(first).includes('freeze #'), 'D the first freeze does not shout its own count');
  const sixth = freezeRecord(GOOD, { sha: 'abcdef0123456789', run: { exit: 1 }, by: 'navigator', forks: 6 });
  check(sixth.forks === 6 && oracleSummary(sixth).includes('freeze #6'), 'D a 6th fork is impossible to miss on any surface that shows the summary');
}
