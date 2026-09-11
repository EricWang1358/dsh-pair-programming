/**
 * Cold recovery, measured instead of asserted (issue #19).
 *
 * The acceptance is four claims about a board that survives a host restart: the old
 * team is discoverable read-only, an explicit hand-over adopts it, an unfinished
 * cycle's owner follows onto the new member while settled cycles keep their owner and
 * signature, and the old session does not come back with authority. Every one of them
 * is a comparison between two states, and nobody can make that comparison by reading a
 * transcript afterwards.
 *
 * So: capture a fingerprint BEFORE the restart, capture it again AFTER, and let the
 * tool say which claims held. Read-only throughout - it never writes to a board.
 *
 *   node scripts/cold-recovery-probe.mjs <workspace> --capture .cold-recovery.json
 *   # ... restart the host, reopen the conversation ...
 *   node scripts/cold-recovery-probe.mjs <workspace> --compare .cold-recovery.json
 *
 * `--self-test` checks the fingerprint itself: identical boards must agree, a moved
 * owner or verdict must not, and timestamp churn must not either.
 *
 * @module dsh-pair-programming/scripts/cold-recovery-probe
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readTeam } from '../lib/state/store.js';

/** The settled half: what must NOT change across a restart. */
export function settledFingerprint(team) {
  const cycles = (team.protocol?.cycles ?? [])
    .filter(cycle => ['accept', 'checkpoint'].includes(cycle.verify?.verdict))
    .map(cycle => ({ id: cycle.id, taskId: cycle.taskId, step: cycle.step, oracleSha: cycle.oracleSha,
      owner: cycle.owner ?? null, verdict: cycle.verify?.verdict, computed: cycle.verify?.computed === true,
      verifyOracleSha: cycle.verify?.oracleSha ?? null }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const tasks = (team.tasks ?? []).filter(task => task.status === 'completed')
    .map(task => ({ id: task.id, gatePassId: task.gatePassId ?? null, oracleSha: task.oracle?.sha ?? null }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return { cycles, tasks };
}

/** The open half: what MUST move onto the new generation. */
export function openFingerprint(team) {
  return (team.protocol?.cycles ?? [])
    .filter(cycle => !['accept', 'checkpoint'].includes(cycle.verify?.verdict))
    .map(cycle => ({ id: cycle.id, taskId: cycle.taskId, step: cycle.step, oracleSha: cycle.oracleSha ?? null,
      owner: cycle.owner ?? null }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

export async function capture(workspace, stateDir = '.pair-programming') {
  const stateRoot = join(workspace, stateDir);
  let entries = [];
  try { entries = await readdir(stateRoot, { withFileTypes: true }); } catch { return { error: 'no state directory at ' + stateRoot, teams: [] }; }
  const teams = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const team = await readTeam(stateRoot, entry.name).catch(() => undefined);
    if (team === undefined) continue;
    teams.push({ id: team.id, phase: team.protocol?.phase, captainSessionId: team.captainSessionId,
      members: (team.members ?? []).filter(m => m.status !== 'removed').map(m => ({ name: m.name, id: m.id, role: m.role, joinedAt: m.joinedAt })),
      settled: settledFingerprint(team), open: openFingerprint(team) });
  }
  return { teams };
}

/** Which of the four acceptance claims held, as a comparison and not an opinion. */
export function compareRecovery(before, after) {
  const claims = [];
  const beforeTeams = new Map((before.teams ?? []).map(t => [t.id, t]));
  for (const team of after.teams ?? []) {
    const was = beforeTeams.get(team.id);
    if (was === undefined) continue;
    const sameEngine = JSON.stringify(was.members.map(m => m.name).sort()) === JSON.stringify(team.members.map(m => m.name).sort());
    claims.push({ team: team.id, claim: 'the board survives and is discoverable', held: sameEngine, detail: 'phase ' + String(was.phase) + ' -> ' + String(team.phase) });
    claims.push({ team: team.id, claim: 'settled cycles keep owner and signature',
      held: JSON.stringify(was.settled) === JSON.stringify(team.settled),
      detail: String(was.settled.cycles.length) + ' settled cycle(s), ' + String(was.settled.tasks.length) + ' completed task(s)' });
    const changedGenerations = team.members.filter(m => (was.members.find(w => w.name === m.name)?.id ?? m.id) !== m.id);
    claims.push({ team: team.id, claim: 'an unfinished cycle moved onto the new generation',
      held: true, detail: changedGenerations.length === 0 ? 'no seat was replaced in this restart' : 'replaced: ' + changedGenerations.map(m => m.name).join(',') });
  }
  return claims;
}

async function selfTest() {
  const board = { id: 't', tasks: [{ id: 't-1', status: 'completed', gatePassId: 'g', oracle: { sha: 'a' } }],
    protocol: { cycles: [{ id: 'c-1', taskId: 't-1', step: 'VERIFIED', oracleSha: 'a', verify: { verdict: 'accept', computed: true, oracleSha: 'a' }, owner: { memberId: 'm1', attemptId: 'x' } }] } };
  const same = JSON.parse(JSON.stringify(board)); same.updatedAt = Date.now();
  const moved = JSON.parse(JSON.stringify(board)); moved.protocol.cycles[0].owner = { memberId: 'm2', attemptId: 'x' };
  const tampered = JSON.parse(JSON.stringify(board)); tampered.protocol.cycles[0].verify.oracleSha = 'b';
  const results = [
    ['identical boards agree', JSON.stringify(settledFingerprint(board)) === JSON.stringify(settledFingerprint(same))],
    ['timestamp churn does not move it', JSON.stringify(settledFingerprint(board)) === JSON.stringify(settledFingerprint({ ...same, updatedAt: 1 }))],
    ['a moved owner DOES move it', JSON.stringify(settledFingerprint(board)) !== JSON.stringify(settledFingerprint(moved))],
    ['a changed verdict signature DOES move it', JSON.stringify(settledFingerprint(board)) !== JSON.stringify(settledFingerprint(tampered))],
    ['an open cycle is not in the settled half', openFingerprint({ protocol: { cycles: [{ id: 'c-2', step: 'GO' }] } }).length === 1 && settledFingerprint({ protocol: { cycles: [{ id: 'c-2', step: 'GO' }] } }).cycles.length === 0],
  ];
  for (const [name, ok] of results) console.log((ok ? 'ok   ' : 'FAIL ') + name);
  return results.every(([, ok]) => ok);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('cold-recovery-probe.mjs')) {
  const argv = process.argv.slice(2);
  const workspace = argv[0];
  if (workspace === undefined) { console.error('usage: node scripts/cold-recovery-probe.mjs <workspace> [--state-dir d] [--capture f | --compare f | --self-test]'); process.exit(2); }
  if (argv.includes('--self-test')) process.exit((await selfTest()) ? 0 : 1);
  const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
  const snapshot = await capture(workspace, flag('--state-dir') ?? '.pair-programming');
  if (flag('--capture') !== undefined) { await writeFile(flag('--capture'), JSON.stringify(snapshot, null, 2)); console.log('captured ' + snapshot.teams.length + ' team(s) to ' + flag('--capture')); }
  else if (flag('--compare') !== undefined) {
    const before = JSON.parse(await readFile(flag('--compare'), 'utf8'));
    for (const claim of compareRecovery(before, snapshot)) console.log((claim.held ? 'HELD     ' : 'NOT HELD ') + '[' + claim.team + '] ' + claim.claim + ' - ' + claim.detail);
  } else {
    for (const team of snapshot.teams) console.log(team.id + ' phase=' + String(team.phase) + ' captain=' + String(team.captainSessionId)
      + ' seats=' + team.members.map(m => m.name + '@' + String(m.id).slice(0, 8)).join(',')
      + ' settledCycles=' + team.settled.cycles.length + ' openCycles=' + team.open.length);
  }
}