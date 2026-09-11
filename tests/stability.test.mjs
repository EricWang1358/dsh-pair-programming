import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, open, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceFileAtomicOrDirect } from '../lib/state/atomic.js';
import { createTeamDir, readTeam, writeTeam, commitMemberReplacement } from '../lib/state/store.js';
import { appendMailbox, createMessage, readMailbox, acknowledgeMailbox } from '../lib/state/mailbox.js';
import { initialProtocolState } from '../lib/protocol/machine.js';
import { installPairScheduler } from '../lib/runtime/scheduler.js';
import { recycleMember } from '../lib/runtime/recycle.js';
import { isMemberRetired } from '../lib/runtime/members.js';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const fixture = (id) => ({ id, name: id, goal: 'probe', mode: 'light',
  captainSessionId: 'cap', createdAt: 1, updatedAt: 1, taskSeq: 0, tasks: [],
  members: [{ id: 'old', name: 'driver', role: 'driver', status: 'idle', joinedAt: 1 }],
  protocol: { ...initialProtocolState(), phase: 'CYCLING' } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

export async function run(check) {
  const root = await mkdtemp(join(tmpdir(), 'pair-stability-'));
  const test = async (name, fn) => { try { await fn(); check(true, name); } catch (e) { check(false, `${name}: ${e.stack}`); } };
  try {
    await test('typecheck distinguishes unavailable execution from invalid syntax', async () => {
      for (const code of ['EPERM', 'ENOENT', 'SYNTAX']) {
        const preload = `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; cp.execFileSync=()=>{throw Object.assign(new Error('injected'),{code:${JSON.stringify(code)},stderr:Buffer.from('injected syntax')})};syncBuiltinESMExports();`;
        const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, 'scripts/typecheck.mjs'], {
          cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8',
        });
        assert.equal(result.status, 1);
        assert.equal(result.stderr.includes('SKIPPED (spawn blocked)'), code !== 'SYNTAX');
        assert.equal(result.stderr.includes('files with syntax errors'), code === 'SYNTAX');
      }
    });
    await test('rename exhaustion preserves canonical and recovery copy without direct overwrite', async () => {
      const target = join(root, 'atomic.json'), temporary = join(root, 'atomic.tmp');
      await writeFile(target, '{"old":true}'); await writeFile(temporary, '{"new":true}');
      let writes = 0, attempts = 0;
      await assert.rejects(replaceFileAtomicOrDirect(temporary, target, '{"new":true}', {
        rename: async () => { attempts++; throw Object.assign(new Error('busy'), { code: 'EPERM' }); },
        writeFile: async p => { writes++; await writeFile(p, '{'); throw new Error('interrupted'); },
        remove: async p => rm(p),
      }, { retries: 2, retryDelayMs: 0 }));
      assert.equal(writes, 0); assert.equal(attempts, 3);
      assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { old: true });
      assert.deepEqual(JSON.parse(await readFile(temporary, 'utf8')), { new: true });
    });
    await test('transient rename failure retries and commits', async () => {
      let attempts = 0;
      await replaceFileAtomicOrDirect('tmp', 'target', 'bytes', {
        rename: async () => { if (++attempts < 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); },
        writeFile: async () => assert.fail('must not overwrite'), remove: async () => assert.fail('must not remove'),
      }, { retryDelayMs: 0 });
      assert.equal(attempts, 2);
    });
    await test('bad team does not block healthy teams in successive sweeps', async () => {
      const stateRoot = join(root, 'state');
      await createTeamDir(stateRoot, fixture('bad')); await createTeamDir(stateRoot, fixture('good'));
      await writeFile(join(stateRoot, 'bad', 'team.json'), '{');
      const warnings = [];
      const ctx = { on() {}, logger: { warn: v => warnings.push(v) }, agents: { get() {} }, subagents: {} };
      const scheduler = installPairScheduler(ctx, { stateDir: 'state', heartbeatMs: 0 });
      scheduler.trackTeam(root, 'bad'); scheduler.trackTeam(root, 'good');
      let kicks = 0; scheduler.kickTeam = async () => { kicks++; };
      await scheduler.heartbeat(); await scheduler.heartbeat();
      assert.equal(kicks, 2); assert.ok(warnings.some(v => v.includes('bad')));
    });
    await test('overlapping sweeps coalesce and dispose prevents new work', async () => {
      const stateRoot = join(root, 'single'); await createTeamDir(stateRoot, fixture('one'));
      const handlers = new Map(), entered = deferred(), finish = deferred(); let kicks = 0;
      const ctx = { on: (n, f) => handlers.set(n, f), logger: { warn() {} }, agents: { get() {} }, subagents: {} };
      const scheduler = installPairScheduler(ctx, { stateDir: 'single', heartbeatMs: 0 });
      scheduler.trackTeam(root, 'one');
      scheduler.kickTeam = async () => { kicks++; entered.resolve(); await finish.promise; };
      const first = scheduler.heartbeat(); await entered.promise;
      const second = scheduler.heartbeat(); finish.resolve(); await Promise.all([first, second]);
      assert.equal(kicks, 1); handlers.get('dispose')(); await scheduler.heartbeat(); assert.equal(kicks, 1);
    });
    await test('hung team yields to healthy team without duplicate work or post-dispose escalation', async () => {
      const stateRoot = join(root, 'deadline');
      await createTeamDir(stateRoot, fixture('slow')); await createTeamDir(stateRoot, fixture('fast'));
      const handlers = new Map(), finish = deferred(); let slow = 0, fast = 0, escalatedSlow = 0;
      const ctx = { on: (n, f) => handlers.set(n, f), logger: { warn() {} }, agents: { get() {} }, subagents: {} };
      const scheduler = installPairScheduler(ctx, { stateDir: 'deadline', heartbeatMs: 0 }, { heartbeatBudgetMs: 20 });
      scheduler.trackTeam(root, 'slow'); scheduler.trackTeam(root, 'fast');
      scheduler.kickTeam = async (_w, id) => { if (id === 'slow') { slow++; await finish.promise; } else fast++; };
      scheduler.escalateIfStalled = async (_w, id) => { if (id === 'slow') escalatedSlow++; };
      await scheduler.heartbeat(); assert.equal(slow, 1); assert.equal(fast, 1);
      await scheduler.heartbeat(); assert.equal(slow, 1); assert.equal(fast, 2);
      handlers.get('dispose')(); finish.resolve(); await new Promise(r => setImmediate(r));
      assert.equal(escalatedSlow, 0);
    });
    await test('resumed captain rediscovers only its valid live teams, and never wakes one into a checkout another team owns', async () => {
      const stateRoot = join(root, 'resume');
      await createTeamDir(stateRoot, fixture('active'));
      await createTeamDir(stateRoot, { ...fixture('other'), captainSessionId: 'other' });
      await createTeamDir(stateRoot, { ...fixture('done'), protocol: { ...initialProtocolState(), phase: 'DONE' } });
      await createTeamDir(stateRoot, fixture('broken')); await writeFile(join(stateRoot, 'broken', 'team.json'), '{');
      const handlers = new Map();
      const ctx = { on: (n, f) => handlers.set(n, f), logger: { warn() {} }, agents: { get() {} }, subagents: {} };
      const scheduler = installPairScheduler(ctx, { stateDir: 'resume', heartbeatMs: 0 });
      await handlers.get('agent/session-start')({ agent: { id: 'cap', session: { header: { cwd: root } } } });
      // J2: 'other' is a live board ON DISK, so this checkout already has an owner and
      // the reopened conversation must not wake its members into it. The archived and
      // the corrupt boards are still ignored, exactly as before.
      assert.deepEqual(scheduler.trackedTeams().map(t => t.teamId), []);
      handlers.get('dispose')();
      // Once that owner is released, the same conversation is rediscovered — releasing
      // is a normal closure/abort of the other board, never a deletion or a bypass.
      await createTeamDir(stateRoot, { ...fixture('other'), captainSessionId: 'other', protocol: { ...initialProtocolState(), phase: 'ABORTED' } });
      const handlers2 = new Map();
      const ctx2 = { on: (n, f) => handlers2.set(n, f), logger: { warn() {} }, agents: { get() {} }, subagents: {} };
      const scheduler2 = installPairScheduler(ctx2, { stateDir: 'resume', heartbeatMs: 0 });
      await handlers2.get('agent/session-start')({ agent: { id: 'cap', session: { header: { cwd: root } } } });
      assert.deepEqual(scheduler2.trackedTeams().map(t => t.teamId), ['active']);
      handlers2.get('dispose')();
    });
    await test('repository commit write failure preserves original valid board', async () => {
      const stateRoot = join(root, 'commit'); const original = fixture('one'); await createTeamDir(stateRoot, original);
      await assert.rejects(commitMemberReplacement(stateRoot, 'one', original.members[0], { ...original.members[0], id: 'new' }, async () => { throw Object.assign(new Error('injected rename failure'), { code: 'PAIR_STATE_COMMIT_FAILED' }); }));
      assert.equal((await readTeam(stateRoot, 'one')).members[0].id, 'old');
    });
    await test('session and dual cycle policies retain seats without spawning', async () => {
      const stateRoot = join(root, 'stable-seats');
      const team = fixture('stable');
      await createTeamDir(stateRoot, team);
      assert.equal((await recycleMember({}, { memberLifetime: 'session' }, {}, stateRoot, team.id, 'driver')).recycled, false);
      team.parallel = { slots: {} };
      await writeTeam(stateRoot, team);
      for (const name of ['driver', 'driver2']) {
        const result = await recycleMember({}, { memberLifetime: 'cycle' }, {}, stateRoot, team.id, name);
        assert.equal(result.reason, 'parallel seats retain their candidate ownership');
      }
    });
    await test('isolated replacement persists new composition and preserves sibling', async () => {
      const stateRoot = join(root, 'isolated-commit');
      const team = fixture('one');
      Object.assign(team.members[0], { runtime: 'isolated', workspace: root, composition: { persona: 'old' } });
      team.members.push({ ...team.members[0], name: 'driver2', id: 'sibling' });
      await createTeamDir(stateRoot, team);
      const replacement = { ...team.members[0], id: 'new', composition: { persona: 'new', toolFilter: { deny: ['pair_verify'] } } };
      assert.equal(await commitMemberReplacement(stateRoot, team.id, team.members[0], replacement), true);
      const saved = await readTeam(stateRoot, team.id);
      assert.deepEqual(saved.members[0].composition, replacement.composition);
      assert.equal(saved.members[0].replacementCount, 1);
      assert.equal(saved.members[0].seatHistory[0].reason, 'recovery');
      assert.equal(saved.members[0].seatHistory[0].previousId, 'old');
      assert.deepEqual(saved.members[1], team.members[1]);
      for (let i=0;i<14;i++) {
        const current=(await readTeam(stateRoot,team.id)).members[0];
        assert.equal(await commitMemberReplacement(stateRoot,team.id,current,{...current,id:'generation-'+i}),true);
      }
      const final=await readTeam(stateRoot,team.id);
      assert.equal(final.members[0].replacementCount,15);
      assert.equal(final.members[0].seatHistory.length,12);
      assert.equal(final.members[1].replacementCount,undefined);

    });
    for (const scenario of ['normal', 'stop', 'terminal-only', 'replacement', 'missing', 'spawn-fail', 'persist-fail', 'session-force']) {
      await test(`recycle transaction: ${scenario}`, async () => {
        const stateRoot = join(root, scenario); await createTeamDir(stateRoot, fixture('race'));
        const captain = { id: 'cap', options: { provider: 'p', model: 'm' }, session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } };
        const interrupted = [], released = [], cancelled = [];
        const ctx = {
          logger: { warn() {} }, agents: { get: id => id === 'cap' ? captain : { cancel: () => cancelled.push(id) } },
          tools: { schemas: () => [{ name: 'read' }] }, llm: { resolveCallConfig: async v => v },
          subagents: {
            getProvider: () => ({ prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } }),
            startContinuable: async () => {
              if (scenario === 'spawn-fail') throw new Error('refused');
              const team = await readTeam(stateRoot, 'race');
              if (scenario === 'stop') { team.protocol.phase = 'ABORTED'; team.members[0].status = 'removed'; }
              if (scenario === 'terminal-only') team.protocol.phase = 'ABORTED';
              if (scenario === 'replacement') team.members[0].id = 'other';
              if (scenario === 'missing') team.members = [];
              await writeTeam(stateRoot, team);
              if (scenario === 'persist-fail') await writeFile(join(stateRoot, 'race', 'team.json'), '{');
              return { childId: 'new' };
            }, interrupt: id => interrupted.push(id),
          },
        };
        const runtime = { selections: { withPending: async (_p, _l, _s, fn) => fn() }, releaseTeamSeats: ids => released.push(...ids) };
        const result = await recycleMember(ctx, { memberLifetime: scenario === 'session-force' ? 'session' : 'cycle', memberProvider: 'test', stateDir: scenario }, runtime, stateRoot, 'race', 'driver', { force: true });
        if (['normal', 'session-force'].includes(scenario)) {
          assert.equal(result.recycled, true); assert.equal((await readTeam(stateRoot, 'race')).members[0].id, 'new');
          assert.deepEqual(interrupted, ['old']); assert.deepEqual(released, ['old']);
          assert.equal(isMemberRetired(ctx, 'old'), true); assert.deepEqual(cancelled, ['old']);
        } else {
          assert.equal(result.recycled, false);
          assert.deepEqual(interrupted, scenario === 'spawn-fail' ? [] : ['new']);
          assert.equal(isMemberRetired(ctx, 'old'), false);
        }
      });
    }
    await test('a host that returns no child id cannot seat a sessionless member', async () => {
      const stateRoot = join(root, 'nochild'); await createTeamDir(stateRoot, fixture('race'));
      const captain = { id: 'cap', options: { provider: 'p', model: 'm' }, session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } };
      const interrupted = [];
      const ctx = {
        logger: { warn() {} }, agents: { get: id => id === 'cap' ? captain : { cancel() {} } },
        tools: { schemas: () => [{ name: 'read' }] }, llm: { resolveCallConfig: async v => v },
        subagents: {
          getProvider: () => ({ prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } }),
          startContinuable: async () => ({ childId: '' }), interrupt: id => interrupted.push(id),
        },
      };
      const runtime = { selections: { withPending: async (_p, _l, _s, fn) => fn() }, releaseTeamSeats() {} };
      const result = await recycleMember(ctx, { memberLifetime: 'cycle', memberProvider: 'test', stateDir: 'nochild' }, runtime, stateRoot, 'race', 'driver', { force: true });
      assert.equal(result.recycled, false);
      assert.equal(result.reason, 'spawn refused');
      assert.deepEqual(interrupted, []);
      assert.equal((await readTeam(stateRoot, 'race')).members[0].id, 'old');
    });
    await test('an append grows the file readers already hold open, it does not replace it', async () => {
      const stateRoot = join(root, 'mail-prefix'); await createTeamDir(stateRoot, fixture('m'));
      const file = join(stateRoot, 'm', 'inbox', 'captain.jsonl');
      for (let i = 0; i < 5; i += 1) await appendMailbox(stateRoot, 'm', 'captain', createMessage('driver', 'captain', `note ${i}`));
      // A handle opened BEFORE the append. The replaced-file path (write temp,
      // rename over the target) leaves this handle on the old inode, so it
      // could never observe the sixth record; an in-place append can.
      const handle = await open(file, 'r');
      try {
        const seen = await handle.readFile('utf8');
        assert.ok(!seen.includes('note 5'));
        await appendMailbox(stateRoot, 'm', 'captain', createMessage('driver', 'captain', 'note 5'));
        // The handle sits at EOF-as-it-was, so a second read returns exactly
        // the bytes the append added — nothing before them was touched.
        const grown = await handle.readFile({ encoding: 'utf8' });
        assert.ok(grown.includes('note 5'), 'the pre-existing handle must see the appended record');
        assert.ok(!grown.includes('note 0'), 'committed records must not be rewritten');
        assert.ok((await readFile(file, 'utf8')).startsWith(seen));
      } finally { await handle.close(); }
      assert.deepEqual((await readMailbox(stateRoot, 'm', 'captain')).map(v => v.content),
        ['note 0', 'note 1', 'note 2', 'note 3', 'note 4', 'note 5']);
    });
    await test('a torn trailing line is skipped, and the next record does not fuse with it', async () => {
      const stateRoot = join(root, 'mail-torn'); await createTeamDir(stateRoot, fixture('m'));
      const file = join(stateRoot, 'm', 'inbox', 'captain.jsonl');
      await appendMailbox(stateRoot, 'm', 'captain', createMessage('driver', 'captain', 'survivor'));
      const whole = await readFile(file, 'utf8');
      // Emulate an append interrupted mid-line: a complete record, then a fragment.
      await writeFile(file, `${whole}{"id":"torn","from":"dri`);
      const malformed = [];
      await appendMailbox(stateRoot, 'm', 'captain', createMessage('driver', 'captain', 'after the tear'));
      const messages = await readMailbox(stateRoot, 'm', 'captain', (line) => malformed.push(line));
      assert.deepEqual(messages.map(v => v.content), ['survivor', 'after the tear']);
      assert.equal(malformed.length, 1);
      assert.ok((await readFile(file, 'utf8')).includes('dri\n{'), 'the fragment must not swallow the new record');
    });
    await test('concurrent appends to one mailbox all land, none interleaved', async () => {
      const stateRoot = join(root, 'mail-race'); await createTeamDir(stateRoot, fixture('m'));
      await Promise.all(Array.from({ length: 40 }, (_, i) =>
        appendMailbox(stateRoot, 'm', 'captain', createMessage('driver', 'captain', `parallel ${i}`))));
      const messages = await readMailbox(stateRoot, 'm', 'captain');
      assert.equal(messages.length, 40);
      assert.deepEqual([...new Set(messages.map(v => v.content))].length, 40);
    });
    await test('acknowledge still rewrites in place, which append cannot express', async () => {
      const stateRoot = join(root, 'mail-ack'); await createTeamDir(stateRoot, fixture('m'));
      for (let i = 0; i < 3; i += 1) await appendMailbox(stateRoot, 'm', 'captain', createMessage('driver', 'captain', `note ${i}`));
      const [first] = await readMailbox(stateRoot, 'm', 'captain');
      await acknowledgeMailbox(stateRoot, 'm', 'captain', [first.id]);
      const after = await readMailbox(stateRoot, 'm', 'captain');
      assert.equal(after.length, 3);
      assert.equal(typeof after[0].readAt, 'number');
      assert.equal(after[1].readAt, undefined);
    });
    await test('a superseded recovery copy is reclaimed; a sibling one and a fresh one are not', async () => {
      const dir = join(root, 'sweep');
      const target = join(dir, 'team.json'), sibling = join(dir, 'other.json');
      await createTeamDir(dir, fixture('placeholder'));
      await writeFile(target, '{}'); await writeFile(sibling, '{}');
      const aged = (path) => `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
      const supersededCopy = aged(target), siblingCopy = aged(sibling), freshCopy = aged(target);
      for (const path of [supersededCopy, siblingCopy, freshCopy]) await writeFile(path, '{"pending":true}');
      const old = new Date(Date.now() - 600_000);
      await utimes(supersededCopy, old, old); await utimes(siblingCopy, old, old);

      // A failed commit registers the target; nothing is reclaimed yet.
      await assert.rejects(replaceFileAtomicOrDirect(supersededCopy, target, '{}', {
        rename: async () => { throw Object.assign(new Error('busy'), { code: 'EPERM' }); },
        writeFile: async () => assert.fail('must not overwrite'), remove: async () => assert.fail('must not remove'),
      }, { retries: 0, retryDelayMs: 0 }));
      assert.ok((await readdir(dir)).includes(supersededCopy.split(/[\\/]/).pop()));

      // The next successful commit of THAT target supersedes it.
      await replaceFileAtomicOrDirect('unused', target, '{}', {
        rename: async () => undefined, writeFile: async () => assert.fail('must not overwrite'), remove: async () => assert.fail('must not remove'),
      });
      const left = await readdir(dir);
      const name = (path) => path.split(/[\\/]/).pop();
      assert.ok(!left.includes(name(supersededCopy)), 'the superseded copy must be reclaimed');
      assert.ok(left.includes(name(freshCopy)), 'a copy young enough to be an in-flight write must survive');
      assert.ok(left.includes(name(siblingCopy)), 'another target\'s uncommitted copy must survive');
    });
    await test('a resume after the scan TTL sees the board as it is now, not as it was', async () => {
      const workspace = join(root, 'ttl'), stateRoot = join(workspace, 'state');
      await createTeamDir(stateRoot, fixture('settling'));
      const handlers = new Map();
      const ctx = { on: (n, f) => handlers.set(n, f), logger: { warn() {} }, agents: { get() {} }, subagents: {} };
      const scheduler = installPairScheduler(ctx, { stateDir: 'state', heartbeatMs: 0 }, { recoveryScanTtlMs: 0 });
      const resume = () => handlers.get('agent/session-start')({ agent: { id: 'cap', session: { header: { cwd: workspace } } } });
      await resume();
      assert.deepEqual(scheduler.trackedTeams().map(t => t.teamId), ['settling']);
      // The team finishes, and the sweep takes it off the list.
      const done = await readTeam(stateRoot, 'settling');
      done.protocol.phase = 'DONE';
      await writeTeam(stateRoot, done);
      scheduler.untrackTeam(workspace, 'settling');
      // A memoised snapshot would put it straight back; a re-read does not.
      await resume();
      assert.deepEqual(scheduler.trackedTeams(), []);
      handlers.get('dispose')();
    });
    await test('concurrent replacement commits choose one generation', async () => {
      const stateRoot = join(root, 'concurrent'), team = fixture('race'); await createTeamDir(stateRoot, team);
      const results = await Promise.all(['a', 'b'].map(id => commitMemberReplacement(stateRoot, 'race', team.members[0], { ...team.members[0], id, joinedAt: 2 })));
      assert.equal(results.filter(Boolean).length, 1);
      assert.ok(['a', 'b'].includes((await readTeam(stateRoot, 'race')).members[0].id));
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}
