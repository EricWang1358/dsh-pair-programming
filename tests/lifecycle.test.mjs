/** rollback: retireSpawnedMembers — interrupt is the obligation, audit is best effort. */
import { mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retireSpawnedMembers, registerLifecycleTools } from '../lib/tools/lifecycle.js';
import { createTeamDir, readTeam } from '../lib/state/store.js';
import { initialProtocolState } from '../lib/protocol/machine.js';

function mockCtx() {
  const calls = [];
  const warns = [];
  const ctx = { logger: { warn: (m) => { warns.push(String(m)); } }, subagents: { interrupt: (id, meta) => { calls.push({ id, meta }); } } };
  return { calls, warns, ctx };
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function rejects(fn, needle) {
  try { await fn(); } catch (error) { return String(error?.message ?? error).includes(needle); }
  return false;
}

/** Register the real lifecycle tools against a mock ctx and grab pair_stop. */
function stopHarness(root, { greenBuildOnStop = false, stateDir = 'stop-state' } = {}) {
  const interrupts = [];
  const defs = [];
  const ctx = {
    logger: { warn: () => {}, debug: () => {}, error: () => {} },
    tools: { register: (d) => { defs.push(d); } },
    subagents: { interrupt: (id) => { interrupts.push(id); } },
    agents: { get: () => undefined },
  };
  registerLifecycleTools(ctx, { stateDir, greenBuildOnStop }, { selections: {}, scheduler: {} });
  const captain = { id: 'cap1', session: { header: { cwd: root }, append: () => {} } };
  return { interrupts, defs, captain, stateRoot: join(root, stateDir) };
}

/** pair_start against a mock ctx; the failOnCall-th role refuses to spawn. */
function startHarness(root, { failOnCall = 2, captainId = 'cap1', stateDir = 'start-state' } = {}) {
  const interrupts = []; const spawns = []; const defs = [];
  const schemas = [{ name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'pair_start' }, { name: 'pair_stop' }, { name: 'pair_rotate' }, { name: 'pair_arbitrate' }];
  const ctx = {
    logger: { warn: () => {}, debug: () => {}, error: () => {} },
    tools: { register: (d) => { defs.push(d); }, schemas: () => schemas },
    agents: { get: () => undefined },
    llm: { resolveCallConfig: async (c) => c },
    subagents: {
      interrupt: (id) => { interrupts.push(id); },
      list: () => ['pair'],
      getProvider: () => ({ prepareContinuable: () => {}, capabilities: { persona: true, toolFilter: true } }),
      startContinuable: async ({ label }) => {
        spawns.push(label);
        if (spawns.length === failOnCall) throw new Error('second role failed to spawn');
        return { childId: `child-${spawns.length}` };
      },
    },
  };
  registerLifecycleTools(ctx, { stateDir, memberProvider: 'pair', greenBuildOnStop: false }, { selections: { withPending: async (i, l, s, op) => op() }, scheduler: {} });
  const captain = { id: captainId, session: { header: { cwd: root }, append: () => {}, requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } };
  return { interrupts, spawns, defs, captain, stateRoot: join(root, stateDir) };
}

function memberOf(id, name) {
  return { id, name, role: name, provider: 'p', model: 'm', status: 'idle', joinedAt: Date.now() };
}

function teamFixture(over = {}) {
  return { id: 't1', name: 'T1', goal: 'g', mode: 'full', captainSessionId: 'cap1', createdAt: Date.now(), updatedAt: Date.now(),
    members: [memberOf('child-1', 'driver'), memberOf('', 'navigator')], tasks: [], taskSeq: 0,
    protocol: initialProtocolState(), evidenceStats: { cacheHits: 0, cacheMiss: 0 }, ...over };
}

export async function run(check) {
  check(typeof retireSpawnedMembers === 'function', 'lifecycle exports retireSpawnedMembers');
  const root = await mkdtemp(join(tmpdir(), 'pair-'));
  try {
    const stateRoot = join(root, 'state');
    const captain = { id: 'cap1' };
    const file = join(stateRoot, 'retired-members.json');
    // AC-1: only members whose spawn resolved get interrupted, in order.
    const a = mockCtx();
    const r1 = await retireSpawnedMembers(a.ctx, captain, stateRoot, [{ id: 'child-1' }, { id: '' }, { id: 'child-2' }]);
    check(JSON.stringify(a.calls.map(c => c.id)) === '["child-1","child-2"]', 'interrupts exactly the spawned ids, skipping empty');
    check(a.calls.every(c => c.meta?.kind === 'ancestor' && c.meta.agent === captain), 'interrupts as ancestor of the captain');
    check(JSON.stringify(r1.retired) === '["child-1","child-2"]', 'reports the retired ids');
    // AC-2: the audit record (write-only today) holds them and stays deduped.
    check(JSON.stringify(JSON.parse(await readFile(file, 'utf8'))) === '["child-1","child-2"]', 'audit file holds the retired ids');
    const b = mockCtx();
    await retireSpawnedMembers(b.ctx, captain, stateRoot, [{ id: 'child-1' }, { id: 'child-2' }]);
    const again = JSON.parse(await readFile(file, 'utf8'));
    check(again.length === 2 && new Set(again).size === 2, 'second call does not duplicate the audit record');
    // AC-1b/AC-2b: nothing spawned, nothing interrupted, no audit file, garbage tolerated.
    const c = mockCtx();
    const emptyRoot = join(root, 'empty-state');
    const r3 = await retireSpawnedMembers(c.ctx, captain, emptyRoot, [{ id: '' }, {}, null]);
    const r4 = await retireSpawnedMembers(c.ctx, captain, emptyRoot, undefined);
    check(c.calls.length === 0 && r3.retired.length === 0 && r4.retired.length === 0, 'no usable ids: zero interrupts, empty report');
    check(await exists(join(emptyRoot, 'retired-members.json')) === false, 'no usable ids: no audit file created');
    // AC-3: one dead child must not stop the rest of the rollback.
    const d = mockCtx();
    d.ctx.subagents.interrupt = (id) => { d.calls.push({ id }); if (id === 'child-1') throw new Error('child gone'); };
    await retireSpawnedMembers(d.ctx, captain, stateRoot, [{ id: 'child-1' }, { id: 'child-2' }]);
    check(d.calls.length === 2 && d.warns.some(w => w.includes('child gone')), 'a throwing interrupt is logged and the rest continue');
    // C1: a failing audit write must never block the interrupts.
    const blocker = join(root, 'blocker');
    await writeFile(blocker, 'x', 'utf8');
    const e = mockCtx();
    await retireSpawnedMembers(e.ctx, captain, join(blocker, 'state'), [{ id: 'child-9' }]);
    check(e.calls.length === 1 && e.calls[0].id === 'child-9', 'audit failure still interrupts the member');
    check(e.warns.some(w => w.includes('retiring members')), 'audit failure is warned, not swallowed');
    // AC-R1/R2/R4: pair_stop through the real handler, not just the helper.
    const h = stopHarness(root);
    const stop = h.defs.find((x) => x.name === 'pair_stop');
    check(!!stop && typeof stop.execute === 'function', 'pair_stop definition captured from ctx.tools.register');
    await createTeamDir(h.stateRoot, teamFixture());
    const res = await stop.execute({ reason: 'wrap up' }, { agent: h.captain });
    check(res.retired === 1, 'pair_stop counts only members with a real session id');
    check(JSON.stringify(h.interrupts) === '["child-1"]', 'pair_stop interrupts the spawned member only');
    check((await readTeam(h.stateRoot, 't1')).protocol.phase === 'DONE', 'pair_stop persists DONE');
    check(JSON.stringify(JSON.parse(await readFile(join(h.stateRoot, 'retired-members.json'), 'utf8'))) === '["child-1"]', 'pair_stop audit record holds the spawned id');
    const stranger = { id: 'cap9', session: { header: { cwd: root }, append: () => {} } };
    check(await rejects(() => stop.execute({}, { agent: stranger }), 'do not belong'), 'a caller with no team fails loudly');
    const member = { id: 'child-1', session: { header: { cwd: root }, append: () => {} } };
    check(await rejects(() => stop.execute({}, { agent: member }), 'only the captain'), 'a non-captain caller is refused');
    // B-1: pair_rotate is refused outright until capabilities follow the role (M2').
    const rotate = h.defs.find((x) => x.name === 'pair_rotate');
    check(await rejects(() => rotate.execute({ new_driver: 'navigator', handoff_note: 'x' }, { agent: h.captain }), 'bound at spawn'), 'pair_rotate refuses its own captain');
    check(await rejects(() => rotate.execute({ new_driver: 'navigator', handoff_note: 'x' }, { agent: member }), 'only the captain'), 'a non-captain hits the permission guard first');
    check(rotate.description.includes('Currently refused in 0.2.x'), 'pair_rotate description carries the refusal marker');
    // AC-A2-1: the sunny path must not regress behind the new rollback catch.
    const s1 = startHarness(root, { failOnCall: -1 });
    const startOk = s1.defs.find((x) => x.name === 'pair_start').execute;
    const ok = await startOk({ goal: 'g', mode: 'light', name: 'a2-ok' }, { agent: s1.captain });
    check(ok.members.length === 2 && s1.spawns.length === 2 && s1.interrupts.length === 0, 'pair_start spawns both roles and interrupts nothing');
    check(await exists(join(s1.stateRoot, 'a2-ok')), 'a successful team keeps its state dir');
    // AC-A2-2..5: a later role failing rolls the earlier one back and rethrows.
    const s2 = startHarness(root, { captainId: 'cap2' });
    const startBad = s2.defs.find((x) => x.name === 'pair_start').execute;
    check(await rejects(() => startBad({ goal: 'g', mode: 'light', name: 'a2-fail' }, { agent: s2.captain }), 'second role failed to spawn'), 'the spawn error propagates unchanged');
    check(JSON.stringify(s2.interrupts) === '["child-1"]', 'the already-spawned driver is interrupted exactly once');
    check(await exists(join(s2.stateRoot, 'a2-fail')) === false, 'the rolled-back team dir is gone');
    check(JSON.stringify(JSON.parse(await readFile(join(s2.stateRoot, 'retired-members.json'), 'utf8'))) === '["child-1"]', 'the rollback audit record holds the interrupted member');
    // AC-A2-6/7: the green-build branch of pair_stop gates before it writes.
    const g = stopHarness(root, { greenBuildOnStop: true, stateDir: 'gb-state' });
    const stopG = g.defs.find((x) => x.name === 'pair_stop').execute;
    await createTeamDir(g.stateRoot, teamFixture({ protocol: { ...initialProtocolState(), cycles: [{ id: 'c1' }] } }));
    check(await rejects(() => stopG({ reason: 'x' }, { agent: g.captain }), 'GREEN BUILD CHECK'), 'a shipped team cannot stop without green evidence');
    check((await readTeam(g.stateRoot, 't1')).protocol.phase !== 'DONE', 'the green-build check fires before any write');
    await stopG({ reason: 'x', green_build_evidence: 'suite green' }, { agent: g.captain });
    const closed = await readTeam(g.stateRoot, 't1');
    check(closed.protocol.greenBuild?.evidence === 'suite green' && closed.protocol.phase === 'DONE', 'supplied evidence is stored and the team closes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
