// Diagnostic reproductions, not passing regression tests. Only temp state is mutated.
//
// SUPERSEDED, AND EXPECTED TO FAIL NOW. Each assertion here describes the
// PRE-FIX behaviour of Q1/Q2/Q3 as it was reproduced on 2026-09-05; the fixes
// in 0.13.6 removed all three, so this script exits non-zero on the first
// assertion by design. It is kept because the review report cites it as the
// evidence the defects were real, not hypothetical. The living guards are the
// eighteen cases in tests/stability.test.mjs; add new ones there, not here.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceFileAtomicOrDirect } from '../../lib/state/atomic.js';
import { createTeamDir, readTeam, writeTeam } from '../../lib/state/store.js';
import { initialProtocolState } from '../../lib/protocol/machine.js';
import { installPairScheduler } from '../../lib/runtime/scheduler.js';
import { recycleMember } from '../../lib/runtime/recycle.js';
import { isMemberRetired } from '../../lib/runtime/members.js';

const root = await mkdtemp(join(tmpdir(), 'pair-quality-'));
const fixture = (id) => ({ id, name: id, goal: 'probe', mode: 'light',
  captainSessionId: 'cap', createdAt: 1, updatedAt: 1, taskSeq: 0, tasks: [],
  members: [{ id: 'old', name: 'driver', role: 'driver', status: 'idle', joinedAt: 1 }],
  protocol: { ...initialProtocolState(), phase: 'CYCLING' } });
try {
  // F1: emulate interruption after truncating the canonical file.
  const target = join(root, 'atomic.json');
  const temporary = join(root, 'atomic.tmp');
  await writeFile(target, '{"old":true}');
  await writeFile(temporary, '{"new":true}');
  await assert.rejects(replaceFileAtomicOrDirect(temporary, target, '{"new":true}', {
    rename: async () => { throw Object.assign(new Error('busy'), { code: 'EPERM' }); },
    writeFile: async (p) => { await writeFile(p, '{'); throw new Error('injected interrupted write'); },
    remove: async (p) => rm(p),
  }, { retries: 0 }));
  assert.equal(await readFile(target, 'utf8'), '{');
  await assert.rejects(readFile(temporary));
  console.log('F1 reproduced: canonical JSON damaged; complete temp copy removed.');

  // F2: one unreadable team blocks a later healthy team in every sweep.
  const stateRoot = join(root, 'state');
  await createTeamDir(stateRoot, fixture('bad'));
  await createTeamDir(stateRoot, fixture('good'));
  await writeFile(join(stateRoot, 'bad', 'team.json'), '{');
  const ctx = { on() {}, logger: { warn() {} }, agents: { get() {} }, subagents: {} };
  const scheduler = installPairScheduler(ctx, { stateDir: 'state', heartbeatMs: 0 });
  scheduler.trackTeam(root, 'bad'); scheduler.trackTeam(root, 'good');
  let goodKicks = 0;
  scheduler.kickTeam = async () => { goodKicks++; };
  for (let i = 0; i < 2; i++) await assert.rejects(scheduler.heartbeat());
  assert.equal(goodKicks, 0);
  console.log('F2 reproduced: two sweeps failed; healthy team received zero kicks.');

  // F3: stop/remove old seat while replacement spawn is in flight.
  await createTeamDir(stateRoot, fixture('race'));
  const captain = { id: 'cap', options: { provider: 'p', model: 'm' }, session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } };
  const interrupted = [];
  const recycleCtx = {
    logger: { warn() {} }, agents: { get: () => captain },
    tools: { schemas: () => [{ name: 'read' }] },
    llm: { resolveCallConfig: async (v) => v },
    subagents: {
      getProvider: () => ({ prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } }),
      startContinuable: async () => {
        const team = await readTeam(stateRoot, 'race');
        team.protocol.phase = 'ABORTED'; team.members[0].status = 'removed';
        await writeTeam(stateRoot, team);
        return { childId: 'new-orphan' };
      },
      interrupt: (id) => interrupted.push(id),
    },
  };
  const runtime = { selections: { withPending: async (_p, _l, _s, fn) => fn() } };
  const result = await recycleMember(recycleCtx, { memberLifetime: 'cycle', memberProvider: 'test', stateDir: 'state' }, runtime, stateRoot, 'race', 'driver', { force: true });
  assert.equal(result.recycled, true);
  assert.equal((await readTeam(stateRoot, 'race')).members[0].id, 'old');
  assert.deepEqual(interrupted, ['old']);
  assert.equal(isMemberRetired(recycleCtx, 'old'), false);
  console.log('F3 reproduced: reports recycled=true, replacement absent from board and never interrupted; old live tombstone absent.');
} finally {
  await rm(root, { recursive: true, force: true });
}
