/**
 * v3.2 loop-drive fixes derived from a 2h 16min live v3 run that produced zero
 * accepted increments: risk scopes, non-gating oracle arms, arbitration
 * budget attribution, and a freeze-count escape hatch.
 */
import { openRisk, blocksImplementation, blocksVerification, scopeOf } from '../lib/protocol/risks.js';
import { initialProtocolState, openCycle } from '../lib/protocol/machine.js';
import { forkProblems, freezeRecord, oracleSummary, nonGatingProblems } from '../lib/protocol/oracle.js';
import { allowedWriteSet, withinScope, scopePath, proposalScopeError as sharedProposalScopeError } from '../lib/protocol/scope.js';
import { boardWriteDenial } from '../lib/runtime/board-guard.js';
import { taskScope } from '../lib/runtime/parallel-tasks.js';

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
  /* ---- E: one allowed write set for proposal, guard and integration ----- */
  // Measured (B3): a probe at scratch/regression/pool-link-guard.mjs was legal
  // at the proposal layer (falls back to proposal.files while scope.declared is
  // false), legal in the write guard (same fallback), and REJECTED by
  // integration, which keyed on scope.writes.length instead. Three layers, three
  // rules, one question. These assertions answer that question from all three
  // call sites, in both declaration shapes.
  const driver = { id: 'd1', name: 'driver', role: 'driver', status: 'idle', joinedAt: 1 };
  const ws = 'C:/pair/driver';
  const board = (scope, proposals, oracleFiles = ['.pair-oracles/t-1/accept.mjs']) => {
    const cycles = proposals.map((files, index) => ({ id: 'c-' + (index + 1), taskId: 't-1', step: 'GO',
      owner: { memberId: 'd1', assignee: 'driver', attemptId: 'one' }, proposal: { files } }));
    const task = { id: 't-1', status: 'claimed', assignee: 'driver', attemptId: 'one', dependencies: [],
      ...(scope === undefined ? {} : { scope }), ...(oracleFiles === undefined ? {} : { oracle: { files: oracleFiles, sha: 'a'.repeat(64) } }) };
    return { id: 'tg', mode: 'light', captainSessionId: 'cap', parallel: { slots: {}, stateRelative: '.pair-programming' },
      members: [driver], tasks: [task], protocol: { phase: 'CYCLING', cycles } };
  };

  // Shape 1 — proposal-only: the card declares no write_paths at all, so what
  // it proposed IS its scope.
  const only = board(undefined, [['scratch/regression/pool-link-guard.mjs']]);
  const onlyTask = only.tasks[0];
  check(allowedWriteSet(onlyTask, only.protocol.cycles).source === 'proposal', 'a card that declares no write_paths is bounded by what it proposed');
  check(withinScope(allowedWriteSet(onlyTask, only.protocol.cycles).allowed, 'scratch/regression/pool-link-guard.mjs'), 'THE measured probe: integration admits the file the proposal declared');
  check(boardWriteDenial(only, 'd1', ws, 'write', { path: 'scratch/regression/pool-link-guard.mjs' }) === undefined, 'and so does the write guard — same set, not a second rule');
  check(sharedProposalScopeError(only, onlyTask, [], ['scratch/regression/pool-link-guard.mjs']) === undefined, 'and the proposal layer reaches the same answer for a file nobody has declared yet');
  const two = board(undefined, [['src/early.mjs'], ['src/late.mjs']]);
  const twoSet = allowedWriteSet(two.tasks[0], two.protocol.cycles);
  check(withinScope(twoSet.allowed, 'src/early.mjs') && withinScope(twoSet.allowed, 'src/late.mjs'), 'the set is a property of the TASK: integration snapshots the whole candidate');
  check(boardWriteDenial(two, 'd1', ws, 'write', { path: 'src/early.mjs' }) === undefined, 'so the guard admits a file an EARLIER cycle proposed — reading only the latest was a second, narrower rule');
  check(String(boardWriteDenial(two, 'd1', ws, 'write', { path: 'src/undeclared.mjs' })).includes('write scope'), 'while a file nobody declared is still refused at the guard');

  // Shape 2 — the envelope. Whether the other two scope arrays were supplied
  // (scope.declared) is an admission flag, not the write rule; keying on it is
  // what let the proposal layer say yes to a file integration said no to.
  const partial = board(taskScope({ write_paths: ['src/a.mjs'] }), [['src/a.mjs'], ['scratch/probe.mjs']]);
  check(partial.tasks[0].scope.declared === false, 'the measured card: write_paths supplied without read_paths/resources, so scope.declared is false');
  const partialError = sharedProposalScopeError(partial, partial.tasks[0], partial.protocol.cycles, ['scratch/probe.mjs']);
  check(typeof partialError === 'string' && partialError.includes('pair_task_amend'), 'THE measured divergence: the envelope wins on this card too, and the refusal names the extension path instead of letting the team discover the contradiction at integration');
  check(boardWriteDenial(partial, 'd1', ws, 'write', { path: 'scratch/probe.mjs' }) !== undefined, 'and the guard refuses the same file, so the layer that writes and the layer that merges no longer disagree');
  const bounded = board(taskScope({ write_paths: ['src/a.mjs'], read_paths: [], resources: [] }), [['src/a.mjs']]);
  check(allowedWriteSet(bounded.tasks[0], bounded.protocol.cycles).source === 'scope.writes', 'a complete declaration reads the same way as an incomplete one: the envelope is the source of truth');
  check(sharedProposalScopeError(bounded, bounded.tasks[0], bounded.protocol.cycles, ['src/a.mjs']) === undefined && boardWriteDenial(bounded, 'd1', ws, 'write', { path: 'src/a.mjs' }) === undefined, 'and a file inside the envelope passes all three layers');

  /* ---- F: directories, oracle artifacts, and the normalization ---------- */
  check(scopePath('src\\a.mjs/') === 'src/a.mjs', 'a declared path is normalized the way the guard and snapshotCandidate read it');
  check(withinScope(['scratch/regression'], 'scratch/regression/pool-link-guard.mjs'), 'a declared DIRECTORY covers a new file inside it');
  check(!withinScope(['scratch/regression'], 'scratch/regression-notes/probe.mjs'), 'and does not cover a sibling that merely starts with the same text');
  const dir = board(taskScope({ write_paths: ['scratch/regression'], read_paths: [], resources: [] }), [['scratch/regression/pool-link-guard.mjs']]);
  check(boardWriteDenial(dir, 'd1', ws, 'write', { path: 'scratch/regression/second-probe.mjs' }) === undefined, 'so a second probe inside the declared directory needs no declaration of its own');
  check(withinScope(allowedWriteSet(dir.tasks[0], dir.protocol.cycles).allowed, 'scratch/regression/second-probe.mjs'), 'and integration snapshots the candidate under the same rule');
  const sealed = board(undefined, [['src/a.mjs']], ['.pair-oracles/t-1/accept.mjs']);
  check(withinScope(allowedWriteSet(sealed.tasks[0], sealed.protocol.cycles).allowed, '.pair-oracles/t-1/accept.mjs'), 'the frozen oracle files are always in the set: integration must not refuse a candidate for carrying the artifact the verdict is computed from');
}