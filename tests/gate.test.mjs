/** gate + risks: the hard completion gate and risk lifecycle. */
import { runGate } from '../lib/protocol/gate.js';
import { openRisk, mitigateRisk, closeRisk, wontfixRisk, openBlockingRisks, hasOpenP0, closeProblems, teamAuthoredPaths } from '../lib/protocol/risks.js';
import { initialProtocolState, openCycle } from '../lib/protocol/machine.js';
import { runDodCommand } from '../lib/tools/gate-exec.js';
import { EvidenceCache } from '../lib/state/evidence-cache.js';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export async function run(check) {
  const p = initialProtocolState();
  // risks lifecycle
  const r = openRisk(p, { severity: 'P0', scenario: 's', trigger: 't', suggestion: 'fix', raisedBy: 'challenger' });
  check(hasOpenP0(p), 'P0 blocks');
  check(openBlockingRisks(p).length === 1, 'one blocking risk');
  mitigateRisk(p, r.id, 'fixed in a.js:10');
  // N3: a MITIGATED blocker still blocks — only a confirmed close clears it.
  check(openBlockingRisks(p).length === 1, 'N3 a MITIGATED P0 still blocks task completion');
  let sentenceClose = 'closed';
  try { closeRisk(p, r.id, 'verified by test'); } catch (error) { sentenceClose = String(error.message); }
  check(sentenceClose.includes('executable artifact') && sentenceClose.includes('closing_cmd'), 'N3 a P0 cannot be closed by a sentence');
  closeRisk(p, r.id, 'verified by test', { closingCmd: 'npm test -- regression', closingExit: 0, closingPaths: ['tests/existing_suite.mjs'] });
  check(!hasOpenP0(p), 'P0 cleared after an artifact-backed close');
  check(p.risks[0].closingArtifact.exit === 0 && p.risks[0].closingArtifact.cmd.includes('npm test'), 'N3 the closing artifact is recorded on the ticket');
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

  // gate-exec (M7'): the configured command runs for real; successes cache by content digest.
  const gx = await mkdtemp(join(tmpdir(), 'gateexec-'));
  try {
    const cache = new EvidenceCache(join(gx, 'state'), true, { cacheHits: 0, cacheMiss: 0 });
    const cmd = `node -e "require('fs').appendFileSync('marker.txt','x')"`;
    const a = await runDodCommand({ dodCommand: cmd }, gx, cache, join(gx, 'state'));
    check(a.exit === 0 && a.cached === false && a.skipped === undefined, 'gate-exec A: non-git workspace runs the command and never caches');
    const b1 = await runDodCommand({ dodCommand: 'node -e "process.exit(3)"' }, gx, cache, join(gx, 'state'));
    check(b1.exit === 3 && typeof b1.outputTail === 'string' && b1.cached === false, 'gate-exec B: failing command reports exit+tail, uncached');
    check((await runDodCommand({ dodCommand: 'node -e "process.exit(3)"' }, gx, cache, join(gx, 'state'))).cached === false, 'gate-exec B: failures are not cached');
    spawnSync('git', ['init'], { cwd: gx });
    await writeFile(join(gx, '.gitignore'), 'marker.txt\n', 'utf8');
    await writeFile(join(gx, 'app.txt'), 'v1', 'utf8');
    spawnSync('git', ['add', '-A'], { cwd: gx });
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: gx });
    const m0 = (await readFile(join(gx, 'marker.txt'), 'utf8')).length;
    const c1 = await runDodCommand({ dodCommand: cmd }, gx, cache, join(gx, 'state'));
    check(c1.exit === 0 && c1.cached === false, 'gate-exec C: first git-workspace run executes');
    const c2 = await runDodCommand({ dodCommand: cmd }, gx, cache, join(gx, 'state'));
    check(c2.cached === true && (await readFile(join(gx, 'marker.txt'), 'utf8')).length === m0 + 1, 'gate-exec C: same bytes hit the cache, marker grew only once');
    const bg1 = await runDodCommand({ dodCommand: 'node -e "process.exit(3)"' }, gx, cache, join(gx, 'state'));
    check(bg1.cached === false && (await runDodCommand({ dodCommand: 'node -e "process.exit(3)"' }, gx, cache, join(gx, 'state'))).cached === false, 'gate-exec B: failures are not cached even in a digestable workspace');
    await writeFile(join(gx, 'app.txt'), 'v2', 'utf8');
    const d = await runDodCommand({ dodCommand: cmd }, gx, cache, join(gx, 'state'));
    check(d.cached === false && (await readFile(join(gx, 'marker.txt'), 'utf8')).length === m0 + 2, 'gate-exec D: changed bytes rerun the command');
  } finally {
    await rm(gx, { recursive: true, force: true });
  }
}
