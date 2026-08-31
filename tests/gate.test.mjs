/** gate + risks: the hard completion gate and risk lifecycle. */
import { runGate } from '../lib/protocol/gate.js';
import { openRisk, mitigateRisk, closeRisk, wontfixRisk, openBlockingRisks, hasOpenP0 } from '../lib/protocol/risks.js';
import { initialProtocolState, openCycle } from '../lib/protocol/machine.js';

export async function run(check) {
  const p = initialProtocolState();
  // risks lifecycle
  const r = openRisk(p, { severity: 'P0', scenario: 's', trigger: 't', suggestion: 'fix', raisedBy: 'challenger' });
  check(hasOpenP0(p), 'P0 blocks');
  check(openBlockingRisks(p).length === 1, 'one blocking risk');
  mitigateRisk(p, r.id, 'fixed in a.js:10');
  closeRisk(p, r.id, 'verified by test');
  check(!hasOpenP0(p), 'P0 cleared after close');
  const r2 = openRisk(p, { severity: 'P2', scenario: 's', trigger: 't', suggestion: 'x', raisedBy: 'challenger' });
  wontfixRisk(p, r2.id, 'cosmetic only');
  check(p.risks.find(x => x.id === r2.id).status === 'WONTFIX', 'wontfix recorded');
  let threw = false;
  try { openRisk(p, { severity: 'P9', scenario: 's', trigger: 't', suggestion: 'x', raisedBy: 'challenger' }); } catch { threw = true; }
  check(threw, 'invalid severity rejected');

  // gate: fails with unaccepted cycle, passes after accept+evidence, risks closed
  const cycle = openCycle(p, 't-1');
  const teamRec = { tasks: [{ id: 't-1' }], protocol: p };
  let g = runGate(teamRec, 't-1');
  check(g.pass === false, 'gate fails: cycle not accepted');
  cycle.verify = { verdict: 'accept', evidence: ['npm test: 5 passed'] };
  cycle.step = 'CLOSED';
  let g2 = runGate(teamRec, 't-1');
  check(g2.pass === true, 'gate passes: accepted + evidence + no blocking risks');

  // gate blocks on an open P1 even when accepted
  openRisk(p, { severity: 'P1', scenario: 'leak', trigger: 't', suggestion: 'x', raisedBy: 'challenger' });
  let g3 = runGate(teamRec, 't-1');
  check(g3.pass === false && g3.failures.some(f => f.includes('P1')), 'gate blocks open P1');

  // gate: Test First (enforce) — accepted cycle without RED/GREEN evidence fails
  const p2 = initialProtocolState();
  const c2 = openCycle(p2, 't-9', { tddMode: 'enforce' });
  c2.step = 'VERIFIED';
  c2.verify = { verdict: 'accept', evidence: ['npm test: 2 passed'] };
  const team2 = { tasks: [{ id: 't-9' }], protocol: p2 };
  let g4 = runGate(team2, 't-9', { tddMode: 'enforce' });
  check(g4.pass === false && g4.failures.some(f => f.includes('Test First')), 'gate enforce blocks accepted-without-RED');
  c2.red = { evidence: ['FAIL: add() is not a function (compile error counts as RED)'], at: 1 };
  c2.green = { evidence: ['PASS: 1 test'], at: 2 };
  let g5 = runGate(team2, 't-9', { tddMode: 'enforce' });
  check(g5.pass === true, 'gate enforce passes with RED before GREEN');
  c2.red = { evidence: ['stale red'], at: 99 }; // RED after GREEN timestamp
  let g6 = runGate(team2, 't-9', { tddMode: 'enforce' });
  check(g6.pass === false && g6.failures.some(f => f.includes('Test First')), 'gate enforce rejects RED recorded after GREEN');
  c2.red = { evidence: ['red'], at: 1 }; // restore c2 so only the trivial-cycle question remains
  // trivial cycles are exempt from Test First
  const c3 = openCycle(p2, 't-9', { tddMode: 'enforce', trivial: true });
  c3.step = 'VERIFIED';
  c3.verify = { verdict: 'accept', evidence: ['lint clean'] };
  let g7 = runGate(team2, 't-9', { tddMode: 'enforce' });
  check(g7.pass === true, 'gate enforce exempts trivial cycles from test-first');

  // gate: spike tasks must record their decision outcome
  const p3 = initialProtocolState();
  const c4 = openCycle(p3, 't-s', { tddMode: 'enforce', trivial: true });
  c4.step = 'VERIFIED';
  c4.verify = { verdict: 'accept', evidence: ['probe built, notes.md'] };
  const spikeTeam = { tasks: [{ id: 't-s', type: 'spike' }], protocol: p3 };
  let g8 = runGate(spikeTeam, 't-s', { tddMode: 'enforce' });
  check(g8.pass === false && g8.failures.some(f => f.includes('spike')), 'gate blocks spike without recorded outcome');
  spikeTeam.tasks[0].output = 'go/no-go: adopt library X (est. 3 cycles)';
  let g9 = runGate(spikeTeam, 't-s', { tddMode: 'enforce' });
  check(g9.pass === true, 'gate passes spike with decision recorded');

  // gate: DoD subset disables individual items
  let g10 = runGate(team2, 't-9', { tddMode: 'enforce', dod: ['all_accepted', 'verify_evidence'] });
  check(g10.pass === true, 'gate honors reduced DoD checklist (no risk/decision/test-first items)');
  check(Array.isArray(g10.checklist.dod) && g10.checklist.dod.length === 2, 'gate checklist echoes active DoD items');
}
