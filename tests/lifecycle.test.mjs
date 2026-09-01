/** Tool-handler behaviour through register-capture: member rollback and the raise budget. */
import { mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retireSpawnedMembers, registerLifecycleTools } from '../lib/tools/lifecycle.js';
import { createTeamDir, readTeam, writeTeam } from '../lib/state/store.js';
import { withLock } from '../lib/state/lock.js';
import { teamLockKey } from '../lib/state/layout.js';
import { registerRiskTools } from '../lib/tools/risk.js';
import { registerArbitrateTools } from '../lib/tools/arbitrate.js';
import { registerFlowTools } from '../lib/tools/flow.js';
import { openRisk } from '../lib/protocol/risks.js';
import { appendMailbox, createMessage, claimMailboxDelivery, releaseMailboxDelivery, acknowledgeMailbox } from '../lib/state/mailbox.js';
import { initialProtocolState, openCycle } from '../lib/protocol/machine.js';

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

/** Register the flow tools; pair_task_update is the guarded one. */
function flowHarness(root, stateDir = 'flow-state') {
  const defs = [];
  registerFlowTools({ logger: { warn: () => {}, debug: () => {}, error: () => {} }, tools: { register: (d) => { defs.push(d); } }, agents: { get: () => undefined }, subagents: { followup: async () => true } }, { stateDir }, { scheduler: {} });
  return { defs, captain: { id: 'cap1', session: { header: { cwd: root }, append: () => {} } }, stateRoot: join(root, stateDir) };
}

/** Register pair_arbitrate against a mock ctx; config carries the planning cap. */
function arbHarness(root, { planningMaxArbitrations = 2, stateDir = 'arb-state' } = {}) {
  const defs = [];
  const ctx = { logger: { warn: () => {}, debug: () => {}, error: () => {} }, tools: { register: (d) => { defs.push(d); } }, agents: { get: () => undefined }, subagents: { followup: async () => true } };
  registerArbitrateTools(ctx, { stateDir, planningMaxArbitrations }, { scheduler: {} });
  return { defs, captain: { id: 'cap1', session: { header: { cwd: root }, append: () => {} } }, stateRoot: join(root, stateDir) };
}

/** Register pair_risk against a mock ctx; config carries the budget under test. */
function riskHarness(root, { maxOpenRisks = 15, stateDir = 'risk-state' } = {}) {
  const defs = [];
  const ctx = {
    logger: { warn: () => {}, debug: () => {}, error: () => {} },
    tools: { register: (d) => { defs.push(d); } },
    agents: { get: () => undefined },
  };
  registerRiskTools(ctx, { stateDir, maxOpenRisks }, { scheduler: {} });
  return { defs, captain: { id: 'cap1', session: { header: { cwd: root }, append: () => {} } }, stateRoot: join(root, stateDir) };
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
    // F1-a: pair_interrupt is the captain's hammer over exactly one live turn.
    const hi = stopHarness(root, { stateDir: 'int-state' });
    const hammer = hi.defs.find((x) => x.name === 'pair_interrupt');
    await createTeamDir(hi.stateRoot, teamFixture());
    const ir = await hammer.execute({ member: 'driver', reason: 'cycle stuck' }, { agent: hi.captain });
    check(JSON.stringify(hi.interrupts) === '["child-1"]' && ir.interrupted === 'driver' && ir.reason === 'cycle stuck' && ir.delivered === true, 'pair_interrupt reports the session it cancelled and that delivery worked');
    check(await rejects(() => hammer.execute({ member: 'driver', reason: 'x' }, { agent: member }), 'only the captain'), 'a non-captain cannot pull the hammer');
    check(await rejects(() => hammer.execute({ member: 'ghost', reason: 'x' }, { agent: hi.captain }), 'member named "ghost"'), 'an unknown member is named in the refusal');
    check(await rejects(() => hammer.execute({ member: 'navigator', reason: 'x' }, { agent: hi.captain }), 'no live session'), 'a member without a session id is refused by name');
    check(await rejects(() => hammer.execute({ member: 'driver', reason: '   ' }, { agent: hi.captain }), 'needs a reason'), 'a blank reason is refused');
    check(hammer.description.includes('not cleared') && !/clears? the queue/i.test(hammer.description), 'the description is honest about the queue');
    // F1-b: pair_status carries the honest queue gauge, lease-aware.
    const ps = stopHarness(root, { stateDir: 'ps-state' });
    const status = ps.defs.find((x) => x.name === 'pair_status').execute;
    await createTeamDir(ps.stateRoot, teamFixture());
    const msgA = createMessage('captain', 'driver', '[PAIR:INFO] first');
    const msgB = createMessage('captain', 'driver', '[PAIR:INFO] second');
    await appendMailbox(ps.stateRoot, 't1', 'driver', msgA);
    await appendMailbox(ps.stateRoot, 't1', 'driver', msgB);
    const gauge = async () => (await status({}, { agent: ps.captain })).members.find((m) => m.name === 'driver')?.mailbox?.pending ?? -1;
    check(await gauge() === 2, 'pair_status counts two unacknowledged messages');
    await claimMailboxDelivery(ps.stateRoot, 't1', 'driver', [msgA.id, msgB.id]);
    check(await gauge() === 0, 'a delivery claimed inside its lease does not count as pending');
    await releaseMailboxDelivery(ps.stateRoot, 't1', 'driver', [msgA.id, msgB.id]);
    check(await gauge() === 2, 'releasing the lease makes the queue pending again');
    await acknowledgeMailbox(ps.stateRoot, 't1', 'driver', [msgA.id, msgB.id]);
    const gauged = await status({}, { agent: ps.captain });
    check(await gauge() === 0 && typeof gauged.pending_note === 'string' && gauged.pending_note.includes('in flight'), 'ack clears the gauge and the note explains what 0 means');
    check(rotate.description.includes('Currently refused in 0.2.x'), 'pair_rotate description carries the refusal marker');
    // ORDER-P1 A: current_cycle must track cycles[] across JSON round-trips.
    const cb = stopHarness(root, { stateDir: 'cc-state' });
    const statusOf = cb.defs.find((x) => x.name === 'pair_status').execute;
    await createTeamDir(cb.stateRoot, teamFixture());
    const bump = async (step) => withLock(teamLockKey(cb.stateRoot, 't1'), async () => {
      const fresh = await readTeam(cb.stateRoot, 't1');
      fresh.protocol.cycles[fresh.protocol.cycles.length - 1].step = step;
      await writeTeam(cb.stateRoot, fresh);
    });
    const open = async (taskId) => withLock(teamLockKey(cb.stateRoot, 't1'), async () => {
      const fresh = await readTeam(cb.stateRoot, 't1');
      openCycle(fresh.protocol, taskId, { tddMode: 'enforce' });
      await writeTeam(cb.stateRoot, fresh);
    });
    await open('t-1');
    await bump('VERIFIED');
    await open('t-1');
    await bump('GREEN');
    const st = await statusOf({}, { agent: cb.captain });
    const back = await readTeam(cb.stateRoot, 't1');
    const last = back.protocol.cycles[back.protocol.cycles.length - 1];
    check(st.current_cycle.id === last.id && st.current_cycle.step === last.step && last.step === 'GREEN',
      'current_cycle tracks cycles[] after write/read round-trips (ORDER-P1 A)');
    // ORDER-P1 B: a legacy frozen currentCycle field is ignored (inert), not migrated.
    const bl = stopHarness(root, { stateDir: 'cc-legacy' });
    const statusLegacy = bl.defs.find((x) => x.name === 'pair_status').execute;
    await createTeamDir(bl.stateRoot, teamFixture({
      protocol: { ...initialProtocolState(), currentCycle: { id: 'c-t-1-1-9', step: 'PROPOSED' }, cycles: [{ id: 'c-t-1-1-9', taskId: 't-1', step: 'VERIFIED' }] },
    }));
    const stLegacy = await statusLegacy({}, { agent: bl.captain });
    check(stLegacy.current_cycle?.step === 'VERIFIED', 'a stale legacy currentCycle field is ignored in favor of cycles[] (ORDER-P1 B)');
    check(stLegacy.summary.includes('c-t-1-1-9@VERIFIED'), 'the legacy-inert fix reaches the summary line too (ORDER-P1 B)');
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
    // F2-b1: the raise budget enforced through the real pair_risk handler.
    const rh = riskHarness(root, { maxOpenRisks: 2 });
    const raise = rh.defs.find((x) => x.name === 'pair_risk').execute;
    const booked = teamFixture();
    await createTeamDir(rh.stateRoot, booked);
    openRisk(booked.protocol, { severity: 'P2', scenario: 's', trigger: 't', suggestion: 'g', raisedBy: 'challenger' });
    openRisk(booked.protocol, { severity: 'P1', scenario: 's', trigger: 't', suggestion: 'g', raisedBy: 'challenger' });
    await writeTeam(rh.stateRoot, booked);
    const refused = await raise({ action: 'raise', severity: 'P2', scenario: 's2', trigger: 't2', suggestion: 'g2' }, { agent: rh.captain }).then(() => '', (e) => String(e?.message ?? e));
    check(refused.includes('cap 2') && refused.includes('2 open non-P0') && /r-\S+\(P2\)/.test(refused), 'the third non-P0 raise is refused with live numbers and a named ticket');
    const afterRefusal = await readTeam(rh.stateRoot, 't1');
    check(afterRefusal.protocol.risks.length === 2, 'a refused raise writes no ticket to the register');
    check(afterRefusal.protocol.stats.attacks === 2, 'a refused raise does not inflate the attack count');
    const p0 = await raise({ action: 'raise', severity: 'P0', scenario: 's3', trigger: 't3', suggestion: 'g3' }, { agent: rh.captain });
    const afterP0 = await readTeam(rh.stateRoot, 't1');
    check(p0.severity === 'P0' && p0.escalated === true && afterP0.protocol.risks.length === 3 && afterP0.protocol.stats.attacks === 3, 'a P0 bypasses the budget, lands on disk, and counts as an attack');
    // F3-2a: the planning cap reaches pair_arbitrate through the config key the chain writes.
    const tsk = (id) => ({ id, subject: 's', status: 'pending', dependencies: [], createdAt: 1, updatedAt: 1 });
    const ah = arbHarness(root, { planningMaxArbitrations: 1 });
    const arbitrate = ah.defs.find((x) => x.name === 'pair_arbitrate').execute;
    await createTeamDir(ah.stateRoot, teamFixture({ tasks: [tsk('t-1')] }));
    const firstArb = await arbitrate({ conflict_ref: 'plan', decision: 'A', evidence: ['a.js:1'], rationale: 'r', task_id: 't-1' }, { agent: ah.captain });
    const secondArb = await arbitrate({ conflict_ref: 'plan', decision: 'B', evidence: ['b.js:1'], rationale: 'r', task_id: 't-1' }, { agent: ah.captain }).then(() => '', (e) => String(e?.message ?? e));
    check(typeof firstArb.decision_id === 'string' && secondArb.includes('used 1 of 1') && secondArb.includes('pick a side'), 'the config cap reaches the guard and the refusal is the predicate text');
    check((await arbitrate({ conflict_ref: 'plan', decision: 'C', evidence: ['c.js:1'], rationale: 'r' }, { agent: ah.captain }).then(() => 'ok', () => 'blocked')) === 'ok', 'a ruling that names no task spends nothing (declared boundary)');
    const capTwo = { id: 'cap2', session: { header: { cwd: root }, append: () => {} } };
    await createTeamDir(ah.stateRoot, teamFixture({ id: 't2', captainSessionId: 'cap2', tasks: [tsk('t-1')], protocol: { ...initialProtocolState(), cycles: [{ taskId: 't-1', openedAt: 5 }], decisions: [{ id: 'd-old', taskId: 't-1', conflictRef: 'plan t-1', at: 1 }] } }));
    const midFrozen = await arbitrate({ conflict_ref: 'plan', decision: 'B', evidence: ['b.js:1'], rationale: 'r', task_id: 't-1' }, { agent: capTwo }).then(() => 'ok', (e) => String(e?.message ?? e));
    check(midFrozen === 'ok', 'a task that already has cycles is exempt from the planning budget');
    // 2b: a task that already has cycles cannot be cancelled without a recorded reason.
    const flh = flowHarness(root);
    const updateTask = flh.defs.find((x) => x.name === 'pair_task_update').execute;
    await createTeamDir(flh.stateRoot, teamFixture({ tasks: [tsk('t-1'), tsk('t-9')], protocol: { ...initialProtocolState(), cycles: [{ taskId: 't-1', openedAt: 5 }] } }));
    const cancelStarted = await updateTask({ task_id: 't-1', status: 'cancelled', attempt_id: 'a-1' }, { agent: flh.captain }).then(() => 'ok', (e) => String(e?.message ?? e));
    check(cancelStarted.includes('already has cycles') && cancelStarted.includes('pair_arbitrate'), 'a started task refuses silent cancellation and names the way through');
    const cancelPlanned = await updateTask({ task_id: 't-9', status: 'cancelled', attempt_id: 'a-1' }, { agent: flh.captain }).then(() => 'ok', (e) => String(e?.message ?? e));
    check(cancelPlanned === 'ok', 'an unplanned task still cancels normally (the guard is not over-broad)');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
