/** M14' RC-1 regression: withLock's cleanup may only retire the chain its own
 * holder installed (serializeMember-shaped identity guard); else a later arrival
 * bypasses a promoted waiter and a stale write-back clobbers team.json. Deferred
 * gates + microtask causality — no wall-clock timing. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLock } from '../lib/state/lock.js';
import { teamLockKey } from '../lib/state/layout.js';
import { createTeamDir, readTeam, writeTeam } from '../lib/state/store.js';
import { initialProtocolState } from '../lib/protocol/machine.js';
export async function run(check) {
  // 1. lock level: a later arrival must queue behind a promoted waiter.
  const ev = [];
  let releaseH, releaseM;
  const hGate = new Promise((r) => { releaseH = r; });
  const mGate = new Promise((r) => { releaseM = r; });
  const h = withLock('m14-lock-1', async () => { ev.push('H:start'); await hGate; ev.push('H:end'); });
  const m = withLock('m14-lock-1', async () => { ev.push('M:start'); await mGate; ev.push('M:end'); });
  releaseH(); // H finishes while M is queued; the cleanup promotes M into the section
  await h;
  const a = withLock('m14-lock-1', async () => { ev.push('A:start'); ev.push('A:end'); });
  releaseM();
  await m;
  await a;
  const want = JSON.stringify(['H:start', 'H:end', 'M:start', 'M:end', 'A:start', 'A:end']);
  check(JSON.stringify(ev) === want, 'lock: later arrival queues behind a promoted waiter (order=' + ev.join(',') + ')');
  // 2. store level: the M14' lost-update shape — pair_stop's DONE write vs an
  // in-flight member-side writer that read PLANNING pre-stop, writes back after.
  const root = await mkdtemp(join(tmpdir(), 'pair-m14-'));
  try {
    const stateRoot = join(root, '.pair-programming');
    const key = teamLockKey(stateRoot, 'm14team');
    const team = { id: 'm14team', name: 'M14', goal: 'g', mode: 'light', captainSessionId: 'cap', createdAt: 1,
      members: [{ id: 'm1', name: 'driver', role: 'driver', joinedAt: 1, status: 'idle' }],
      tasks: [], taskSeq: 0, protocol: initialProtocolState(), evidenceStats: { cacheHits: 0, cacheMiss: 0 } };
    team.protocol.phase = 'PLANNING';
    await createTeamDir(stateRoot, team);
    const ev2 = [];
    let resolveMRead, releaseH2, releaseM2;
    const mRead = new Promise((r) => { resolveMRead = r; });
    const hGate2 = new Promise((r) => { releaseH2 = r; });
    const mGate2 = new Promise((r) => { releaseM2 = r; });
    const h2 = withLock(key, async () => { await hGate2; });
    const m2 = withLock(key, async () => { // member-side writer: reads under the lock, pauses holding the stale object
      const fresh = await readTeam(stateRoot, 'm14team');
      resolveMRead(fresh);
      await mGate2;
      fresh.members[0].status = 'working';
      await writeTeam(stateRoot, fresh); // stale whole-object write-back
    });
    releaseH2(); // bug: this cleanup also drops M's queued chain — the bypass precondition
    await h2;
    const stale = await mRead;
    check(stale.protocol.phase === 'PLANNING', 'fixture: member read the pre-stop phase');
    const a2 = withLock(key, async () => { // pair_stop shape (lifecycle.js:224-237)
      ev2.push('A:start');
      const fresh = await readTeam(stateRoot, 'm14team');
      fresh.protocol.phase = 'DONE';
      await writeTeam(stateRoot, fresh);
    });
    for (let i = 0; i < 10; i += 1) await Promise.resolve(); // a bypassing A starts within microtasks; a queued one cannot start at all
    const bypassed = ev2.includes('A:start');
    if (bypassed) await a2; // bug world: let stopA land DONE while M still holds the stale object
    releaseM2();
    await m2;
    if (!bypassed) await a2; // fixed world: stopA was queued and runs after M
    const final = await readTeam(stateRoot, 'm14team');
    check(final.protocol.phase === 'DONE', 'stopA DONE survives the in-flight member write-back (final=' + final.protocol.phase + ', bypassed=' + bypassed + ')');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
