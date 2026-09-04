/** state layer against a real temp FS: lock, atomic write, mailbox, store, cache. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLock, sanitizeKey } from '../lib/state/lock.js';
import { atomicWriteText } from '../lib/state/atomic.js';
import { appendMailbox, readMailbox, readUnreadMailbox, acknowledgeMailbox, createMessage } from '../lib/state/mailbox.js';
import { createTeamDir, readTeam, writeTeam, transitionError, beginTaskAttempt, invalidateTaskAttempt, recordGatePass, latestGatePass, findTeamByCaptain } from '../lib/state/store.js';
import { initialProtocolState } from '../lib/protocol/machine.js';
import { EvidenceCache } from '../lib/state/evidence-cache.js';
import { readFile } from 'node:fs/promises';

export async function run(check) {
  const root = await mkdtemp(join(tmpdir(), 'pair-'));
  try {
    const stateRoot = join(root, '.pair-programming');

    // lock runs all serialized
    let order = [];
    await Promise.all([1, 2, 3].map(i => withLock('k', async () => { await new Promise(r => setTimeout(r, 10 - i)); order.push(i); })));
    check(order.length === 3, 'lock serialized (all ran)');

    // sanitizeKey
    check(sanitizeKey('Driver One') === 'driver-one', 'sanitize folds space');
    check(sanitizeKey('成员甲') === '成员甲', 'unicode survives');
    check(sanitizeKey('!!!').startsWith('k-'), 'pure-symbol digest key');

    // atomic write roundtrip
    const wf = join(root, 'w.txt');
    await atomicWriteText(wf, 'hello');
    check((await readFile(wf, 'utf8')) === 'hello', 'atomic write/read');

    // team CRUD + state machine + attempt
    const team = { id: 't1', name: 'T1', goal: 'g', mode: 'full', captainSessionId: 'cap1', createdAt: Date.now(), updatedAt: Date.now(), members: [], tasks: [{ id: 't-1', subject: 's', status: 'pending', dependencies: [], createdAt: Date.now(), updatedAt: Date.now() }], taskSeq: 1, protocol: initialProtocolState(), evidenceStats: { cacheHits: 0, cacheMiss: 0 } };
    await createTeamDir(stateRoot, team);
    const back = await readTeam(stateRoot, 't1');
    check(back?.id === 't1' && back.protocol.phase === 'FORMING', 'team roundtrip');
    check((await findTeamByCaptain(stateRoot, 'cap1'))?.id === 't1', 'findTeamByCaptain');
    check(transitionError('pending', 'claimed') === undefined, 'pending->claimed ok');
    check(transitionError('completed', 'pending') !== undefined, 'terminal immutable');
    const task = back.tasks[0];
    const att = beginTaskAttempt(task, 'driver');
    check(task.status === 'claimed' && task.attemptId === att, 'attempt activates');
    invalidateTaskAttempt(task);
    check(task.attemptId === undefined && task.status === 'pending', 'invalidate revokes');
    const gp = recordGatePass(back, 't-1', { ok: true, at: 1 }, { worktreeSha: 'tree', gateStateSha: 'board' });
    const replayed = recordGatePass(back, 't-1', { ok: true, at: 999 }, { worktreeSha: 'tree', gateStateSha: 'board' });
    check(latestGatePass(back, 't-1')?.id === gp.id, 'gate pass recorded');
    check(replayed.id === gp.id && back.protocol.gatePasses.length === 1, 'an identical gate replay returns the same credential instead of appending a random id');
    const changedPass = recordGatePass(back, 't-1', { ok: true, at: 1000 }, { worktreeSha: 'tree-2', gateStateSha: 'board' });
    check(changedPass.id !== gp.id && back.protocol.gatePasses.length === 2, 'a changed gate binding issues a new credential');

    // mailbox
    await appendMailbox(stateRoot, 't1', 'navigator', createMessage('driver', 'navigator', '[PAIR:PROPOSE] {}'));
    let unread = await readUnreadMailbox(stateRoot, 't1', 'navigator');
    check(unread.length === 1 && unread[0].content.startsWith('[PAIR:PROPOSE]'), 'mailbox append+unread');
    await acknowledgeMailbox(stateRoot, 't1', 'navigator', [unread[0].id]);
    unread = await readUnreadMailbox(stateRoot, 't1', 'navigator');
    check(unread.length === 0, 'ack clears unread');
    const all = await readMailbox(stateRoot, 't1', 'navigator');
    check(all.length === 1 && all[0].readAt !== undefined, 'read preserves acked');

    // evidence cache hit/miss + precise invalidation
    const stats = { cacheHits: 0, cacheMiss: 0 };
    const cache = new EvidenceCache(stateRoot, true, stats);
    check((await cache.getFileDigest('head1', 'a.js', 123)) === undefined && stats.cacheMiss === 1, 'cache miss');
    await cache.setFileDigest('head1', 'a.js', 123, { symbols: ['x'] });
    const hit = await cache.getFileDigest('head1', 'a.js', 123);
    check(hit?.symbols?.[0] === 'x' && stats.cacheHits === 1, 'cache hit');
    check((await cache.getFileDigest('head1', 'a.js', 124)) === undefined, 'mtime change invalidates');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
