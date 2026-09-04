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
import { appendMailbox, createMessage, claimMailboxDelivery, releaseMailboxDelivery, acknowledgeMailbox, readUnreadMailbox } from '../lib/state/mailbox.js';
import { initialProtocolState, openCycle } from '../lib/protocol/machine.js';
import { gateStateFingerprint } from '../lib/protocol/gate.js';
import { workspaceFingerprint } from '../lib/tools/oracle-exec.js';

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
function arbHarness(root, { planningMaxArbitrations = 2, stateDir = 'arb-state', ...cfg } = {}) {
  const defs = [];
  const ctx = { logger: { warn: () => {}, debug: () => {}, error: () => {} }, tools: { register: (d) => { defs.push(d); } }, agents: { get: () => undefined }, subagents: { followup: async () => true } };
  registerArbitrateTools(ctx, { stateDir, planningMaxArbitrations, ...cfg }, { scheduler: {} });
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
  return { interrupts, defs, captain, ctx, stateRoot: join(root, stateDir) };
}

/** pair_start against a mock ctx; the failOnCall-th role refuses to spawn. */
function startHarness(root, { failOnCall = 2, captainId = 'cap1', stateDir = 'start-state' } = {}) {
  const interrupts = []; const spawns = []; const starts = []; const defs = [];
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
      startContinuable: async (start) => {
        const { label } = start;
        starts.push(start);
        spawns.push(label);
        if (spawns.length === failOnCall) throw new Error('second role failed to spawn');
        return { childId: `child-${spawns.length}` };
      },
    },
  };
  registerLifecycleTools(ctx, { stateDir, memberProvider: 'pair', greenBuildOnStop: false }, { selections: { withPending: async (i, l, s, op) => op() }, scheduler: {} });
  const captain = { id: captainId, session: { header: { cwd: root }, append: () => {}, requestHeader: () => ({ config: { provider: 'p', model: 'm', reasoningEffort: 'high' } }) } };
  return { interrupts, spawns, starts, defs, captain, stateRoot: join(root, stateDir) };
}

function memberOf(id, name) {
  return { id, name, role: name, provider: 'p', model: 'm', status: 'idle', joinedAt: Date.now() };
}

function teamFixture(over = {}) {
  return { id: 't1', name: 'T1', goal: 'g', mode: 'full', captainSessionId: 'cap1', createdAt: Date.now(), updatedAt: Date.now(),
    members: [memberOf('child-1', 'driver'), memberOf('', 'navigator')], tasks: [], taskSeq: 0,
    protocol: initialProtocolState(), evidenceStats: { cacheHits: 0, cacheMiss: 0 }, ...over };
}

const USE_CASES = [{ actor: 'maintainer', intent: 'change the plugin', outcome: 'ship verified behavior', acceptance_criteria: ['the requested behavior passes'] }];
function successfulTeam(over = {}) {
  const protocol = { ...initialProtocolState(), phase: 'RETRO', gatePasses: [{ id: 'gp-1', taskId: 't-1', at: 1 }] };
  return teamFixture({
    useCases: [{ id: 'UC-1', actor: 'maintainer', intent: 'change', outcome: 'ship', acceptanceCriteria: [{ id: 'UC-1.AC-1', text: 'passes' }] }],
    tasks: [{ id: 't-1', subject: 's', status: 'completed', gatePassId: 'gp-1', acceptanceRefs: ['UC-1.AC-1'], oracle: { caseRefs: ['UC-1.AC-1'] }, dependencies: [], createdAt: 1, updatedAt: 1 }],
    protocol, processLessons: { at: 1, keep: ['x'], try: [] }, ...over,
  });
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
    const res = await stop.execute({ outcome: 'aborted', reason: 'wrap up' }, { agent: h.captain });
    check(res.retired === 1, 'pair_stop counts only members with a real session id');
    check(JSON.stringify(h.interrupts) === '["child-1"]', 'pair_stop interrupts the spawned member only');
    const aborted = await readTeam(h.stateRoot, 't1');
    check(aborted.protocol.phase === 'ABORTED' && aborted.protocol.completionReceipt === undefined, 'pair_stop persists honest ABORTED without a success receipt');
    check(aborted.members.every(m => m.id === '' || m.status === 'removed'), 'pair_stop marks retired seats removed on the canonical board');
    check(JSON.stringify(JSON.parse(await readFile(join(h.stateRoot, 'retired-members.json'), 'utf8'))) === '["child-1"]', 'pair_stop audit record holds the spawned id');
    const stranger = { id: 'cap9', session: { header: { cwd: root }, append: () => {} } };
    check(await rejects(() => stop.execute({}, { agent: stranger }), 'do not belong'), 'a caller with no team fails loudly');
    const member = { id: 'child-1', session: { header: { cwd: root }, append: () => {} } };
    check(await rejects(() => stop.execute({}, { agent: member }), 'do not belong'), 'a retired member is disconnected from the archived team');
    // B-1: pair_rotate is refused outright until capabilities follow the role (M2').
    const rotate = h.defs.find((x) => x.name === 'pair_rotate');
    check(await rejects(() => rotate.execute({ new_driver: 'navigator', handoff_note: 'x' }, { agent: h.captain }), 'bound at spawn'), 'pair_rotate refuses its own captain');
    check(await rejects(() => rotate.execute({ new_driver: 'navigator', handoff_note: 'x' }, { agent: member }), 'do not belong'), 'a retired member cannot route back into lifecycle tools');
    // F1-a: pair_interrupt is the captain's hammer over exactly one live turn.
    const hi = stopHarness(root, { stateDir: 'int-state' });
    const hammer = hi.defs.find((x) => x.name === 'pair_interrupt');
    await createTeamDir(hi.stateRoot, teamFixture());
    const queued = createMessage('captain', 'driver', '[PAIR:INFO] stale');
    await appendMailbox(hi.stateRoot, 't1', 'driver', queued);
    let cleared = false;
    hi.ctx.agents.get = (id) => id === 'child-1' ? { cancel: () => { cleared = true; } } : undefined;
    const ir = await hammer.execute({ member: 'driver', reason: 'cycle stuck' }, { agent: hi.captain });
    check(JSON.stringify(hi.interrupts) === '["child-1"]' && ir.interrupted === 'driver' && ir.reason === 'cycle stuck' && ir.delivered === true, 'pair_interrupt reports the session it cancelled and that delivery worked');
    check(cleared && ir.discarded === 1 && (await readUnreadMailbox(hi.stateRoot, 't1', 'driver')).length === 0, 'pair_interrupt atomically clears the host inbox and durable pair backlog by default');
    check(await rejects(() => hammer.execute({ member: 'driver', reason: 'x' }, { agent: member }), 'only the captain'), 'a non-captain cannot pull the hammer');
    check(await rejects(() => hammer.execute({ member: 'ghost', reason: 'x' }, { agent: hi.captain }), 'member named "ghost"'), 'an unknown member is named in the refusal');
    check(await rejects(() => hammer.execute({ member: 'navigator', reason: 'x' }, { agent: hi.captain }), 'no live session'), 'a member without a session id is refused by name');
    check(await rejects(() => hammer.execute({ member: 'driver', reason: '   ' }, { agent: hi.captain }), 'needs a reason'), 'a blank reason is refused');
    check(hammer.description.includes('clears') && !hammer.description.includes('not cleared'), 'the description promises the queue flush the handler now performs');
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
    check(/Currently refused in [\d.x]+/.test(rotate.description) && rotate.description.includes('bound at spawn time'), 'pair_rotate description carries the refusal marker and its reason (not pinned to one version literal)');
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
    // The tuning declaration must SURFACE, or collecting it is theatre: the
    // point is that a human, the captain and the retro all get to look at a
    // product that was bent to fit its own measuring instrument, which no
    // re-run can ever show them.
    await withLock(teamLockKey(cb.stateRoot, 't1'), async () => {
      const fresh = await readTeam(cb.stateRoot, 't1');
      fresh.protocol.cycles[0].green = { evidence: ['g'], tunedForOracle: 'none', at: 1 };
      fresh.protocol.cycles[1].green = { evidence: ['g'], tunedForOracle: 'rain opacity 0.4 -> 0.18 so the idle patches stay under the diff threshold', at: 1 };
      await writeTeam(cb.stateRoot, fresh);
    });
    const tunedStatus = await statusOf({}, { agent: cb.captain });
    check(tunedStatus.summary.includes('Tuned to the instrument:') && tunedStatus.summary.includes('0.4 -> 0.18'),
      'a declared tuning-to-the-oracle is visible on the board, where the captain and the retro read it');
    check(!tunedStatus.summary.split('Tuned to the instrument:')[1].split(String.fromCharCode(10))[0].includes('none'),
      'and an honest "none" adds no noise to that line');

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
    const ok = await startOk({ goal: 'g', mode: 'light', name: 'a2-ok', use_cases: USE_CASES }, { agent: s1.captain });
    check(ok.members.length === 2 && s1.spawns.length === 2 && s1.interrupts.length === 0, 'pair_start spawns both roles and interrupts nothing');
    check(s1.starts.every(start => start.request.agentOptions?.reasoningEffort === 'high'), 'member reasoning effort is persisted in alpha.5 continuable agentOptions');
    check(await exists(join(s1.stateRoot, 'a2-ok')), 'a successful team keeps its state dir');
    const sm = startHarness(root, { failOnCall: -1, captainId: 'cap-solo', stateDir: 'solo-start' });
    const soloStarted = await sm.defs.find(x => x.name === 'pair_start').execute({ goal: 'g', mode: 'solo', name: 'explicit-solo', use_cases: USE_CASES }, { agent: sm.captain });
    check(soloStarted.mode === 'solo' && sm.spawns.length === 1 && sm.spawns[0].endsWith(':spec'), 'explicit mode=solo is reachable and spawns only the SPEC seat');
    const noScope = startHarness(root, { failOnCall: -1, captainId: 'cap-no-scope', stateDir: 'no-scope-start' });
    check(await rejects(() => noScope.defs.find(x => x.name === 'pair_start').execute({ goal: 'g', mode: 'solo', name: 'no-scope' }, { agent: noScope.captain }), 'missing required property "use_cases"'), 'pair_start refuses to lose the request before a team exists');
    // AC-A2-2..5: a later role failing rolls the earlier one back and rethrows.
    const s2 = startHarness(root, { captainId: 'cap2' });
    const startBad = s2.defs.find((x) => x.name === 'pair_start').execute;
    check(await rejects(() => startBad({ goal: 'g', mode: 'light', name: 'a2-fail', use_cases: USE_CASES }, { agent: s2.captain }), 'second role failed to spawn'), 'the spawn error propagates unchanged');
    check(JSON.stringify(s2.interrupts) === '["child-1"]', 'the already-spawned driver is interrupted exactly once');
    check(await exists(join(s2.stateRoot, 'a2-fail')) === false, 'the rolled-back team dir is gone');
    check(JSON.stringify(JSON.parse(await readFile(join(s2.stateRoot, 'retired-members.json'), 'utf8'))) === '["child-1"]', 'the rollback audit record holds the interrupted member');
    // AC-A2-6/7: the green-build branch of pair_stop gates before it writes.
    const g = stopHarness(root, { greenBuildOnStop: true, stateDir: 'gb-state' });
    const stopG = g.defs.find((x) => x.name === 'pair_stop').execute;
    await createTeamDir(g.stateRoot, successfulTeam());
    const terminalBoard = await readTeam(g.stateRoot, 't1');
    terminalBoard.protocol.gatePasses[0].binding = {
      gateStateSha: gateStateFingerprint(terminalBoard, 't-1'),
      worktreeSha: await workspaceFingerprint(root, { stateDir: 'gb-state' }),
    };
    await writeTeam(g.stateRoot, terminalBoard);
    check(await rejects(() => stopG({ reason: 'x', green_build_evidence: 'trust me: green' }, { agent: g.captain }), 'machine-run whole-suite command'), 'a successful team rejects pasted green prose without executing a command');
    check((await readTeam(g.stateRoot, 't1')).protocol.phase !== 'DONE', 'the green-build check fires before any write');
    const completion = await stopG({ reason: 'x', green_build_command: 'node --version' }, { agent: g.captain });
    const closed = await readTeam(g.stateRoot, 't1');
    check(closed.protocol.greenBuild?.evidence.includes('command: node --version') && closed.protocol.greenBuild?.evidence.includes('exit: 0') && closed.protocol.phase === 'DONE', 'the plugin-run command result is stored and the team closes');
    check(typeof closed.protocol.completionReceipt?.id === 'string' && closed.protocol.completionReceipt.id === completion.completion_receipt?.id, 'successful stop persists and returns the same completion receipt');
    const staleGate = stopHarness(root, { greenBuildOnStop: false, stateDir: 'stale-gate-state' });
    const staleTeam = successfulTeam();
    staleTeam.protocol.gatePasses[0].binding = { gateStateSha: gateStateFingerprint(staleTeam, 't-1'), worktreeSha: 'old-tree' };
    await createTeamDir(staleGate.stateRoot, staleTeam);
    check(await rejects(() => staleGate.defs.find(x => x.name === 'pair_stop').execute({ outcome: 'complete' }, { agent: staleGate.captain }), 'stale against the final worktree'), 'successful stop rechecks gate credentials against the final worktree');
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
  // ORDER-P3b-2: pair_gate_check runs the configured dodCommand itself (M7').
  const gh = arbHarness(root, { stateDir: 'gateexec-state', dodCommand: 'node -e "process.exit(0)"' });
  const gate = gh.defs.find((x) => x.name === 'pair_gate_check').execute;
  await createTeamDir(gh.stateRoot, teamFixture({ tasks: [{ ...tsk('t-1'), status: 'in_progress', assignee: 'driver', attemptId: 'gate-attempt' }], protocol: { ...initialProtocolState(), cycles: [{ id: 'c1', taskId: 't-1', step: 'VERIFIED', verify: { verdict: 'accept', evidence: ['suite green'] } }] } }));
  const gr = await gate({ task_id: 't-1' }, { agent: gh.captain });
  check(gr.pass === true && typeof gr.gate_pass_id === 'string', 'pair_gate_check runs the configured dodCommand and passes');
  const gp = (await readTeam(gh.stateRoot, 't1')).protocol.gatePasses[0];
  check(gp.exit === 0 && gp.cached === false && typeof gp.command === 'string' && typeof gp.outputSha === 'string', 'the gate pass record carries the command face {command, exit, outputSha, cached}');
  const grReplay = await gate({ task_id: 't-1' }, { agent: gh.captain });
  const gateBoard = await readTeam(gh.stateRoot, 't1');
  check(grReplay.gate_pass_id === gr.gate_pass_id && grReplay.credential_reused === true && gateBoard.protocol.gatePasses.length === 1, 'an identical pair_gate_check replay is idempotent');
  check(gateBoard.tasks[0].gatePassId === gr.gate_pass_id && typeof gateBoard.protocol.gatePasses[0].binding.gateStateSha === 'string', 'the task carries the current gate id and the pass binds the board facts it judged');
  gateBoard.protocol.risks.push({ id: 'r-after-gate', severity: 'P1', status: 'OPEN', scenario: 'new blocker', openedAt: Date.now() });
  await writeTeam(gh.stateRoot, gateBoard);
  const gateFlow = flowHarness(root, 'gateexec-state');
  const staleBoard = await gateFlow.defs.find((x) => x.name === 'pair_task_update').execute({ task_id: 't-1', status: 'completed', attempt_id: 'gate-attempt', gate_pass_id: gr.gate_pass_id }, { agent: gh.captain }).then(() => '', error => String(error?.message ?? error));
  check(staleBoard.includes('GATE_STALE') && staleBoard.includes('risk register'), 'a board-only blocker raised after the gate invalidates the credential');
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
