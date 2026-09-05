import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceFileAtomicOrDirect } from '../lib/state/atomic.js';
import { createTeamDir, readTeam, writeTeam, commitMemberReplacement } from '../lib/state/store.js';
import { initialProtocolState } from '../lib/protocol/machine.js';
import { installPairScheduler } from '../lib/runtime/scheduler.js';
import { recycleMember } from '../lib/runtime/recycle.js';
import { isMemberRetired } from '../lib/runtime/members.js';
import { spawnSync } from 'node:child_process';
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
    await test('resumed captain rediscovers only its valid live teams', async () => {
      const stateRoot = join(root, 'resume');
      await createTeamDir(stateRoot, fixture('active'));
      await createTeamDir(stateRoot, { ...fixture('other'), captainSessionId: 'other' });
      await createTeamDir(stateRoot, { ...fixture('done'), protocol: { ...initialProtocolState(), phase: 'DONE' } });
      await createTeamDir(stateRoot, fixture('broken')); await writeFile(join(stateRoot, 'broken', 'team.json'), '{');
      const handlers = new Map();
      const ctx = { on: (n, f) => handlers.set(n, f), logger: { warn() {} }, agents: { get() {} }, subagents: {} };
      const scheduler = installPairScheduler(ctx, { stateDir: 'resume', heartbeatMs: 0 });
      await handlers.get('agent/session-start')({ agent: { id: 'cap', session: { header: { cwd: root } } } });
      assert.deepEqual(scheduler.trackedTeams().map(t => t.teamId), ['active']);
      handlers.get('dispose')();
    });
    await test('repository commit write failure preserves original valid board', async () => {
      const stateRoot = join(root, 'commit'); const original = fixture('one'); await createTeamDir(stateRoot, original);
      await assert.rejects(commitMemberReplacement(stateRoot, 'one', original.members[0], { ...original.members[0], id: 'new' }, async () => { throw Object.assign(new Error('injected rename failure'), { code: 'PAIR_STATE_COMMIT_FAILED' }); }));
      assert.equal((await readTeam(stateRoot, 'one')).members[0].id, 'old');
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
    await test('concurrent replacement commits choose one generation', async () => {
      const stateRoot = join(root, 'concurrent'), team = fixture('race'); await createTeamDir(stateRoot, team);
      const results = await Promise.all(['a', 'b'].map(id => commitMemberReplacement(stateRoot, 'race', team.members[0], { ...team.members[0], id, joinedAt: 2 })));
      assert.equal(results.filter(Boolean).length, 1);
      assert.ok(['a', 'b'].includes((await readTeam(stateRoot, 'race')).members[0].id));
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}
