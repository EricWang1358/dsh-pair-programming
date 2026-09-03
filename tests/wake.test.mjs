/**
 * N5 liveness: a mailbox-only delivery must schedule its own recovery kick,
 * and the heartbeat must sweep tracked teams. The regression this pins is the
 * O3 stall — GO on the board, Driver never woken, timebox burned.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerWakeRuntime, wakeRuntimeFor, scheduleWake } from '../lib/runtime/wake.js';
import { installPairScheduler } from '../lib/runtime/scheduler.js';
import { registerFlowTools } from '../lib/tools/flow.js';
import { registerTaskTools } from '../lib/tools/task.js';
import { createTeamDir, readTeam } from '../lib/state/store.js';
import { initialProtocolState, openCycle } from '../lib/protocol/machine.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function memberOf(id, role) {
  return { id, name: role, role, status: 'idle', joinedAt: 1 };
}

function teamFixture(over = {}) {
  return {
    id: 't1', name: 'T1', goal: 'g', mode: 'light', tddMode: 'enforce', pairStyle: 'traditional',
    captainSessionId: 'cap1', createdAt: 1, updatedAt: 1,
    members: [memberOf('child-driver', 'driver'), memberOf('child-nav', 'navigator')],
    tasks: [{ id: 't-1', subject: 's', status: 'in_progress', assignee: 'driver', attemptId: 'a-1', dependencies: [], createdAt: 1, updatedAt: 1 }],
    taskSeq: 1, protocol: initialProtocolState(), evidenceStats: { cacheHits: 0, cacheMiss: 0 }, ...over,
  };
}

/** Flow tools over a ctx whose live wake ALWAYS fails — the stall condition. */
function stalledHarness(root, kicks, { followupOk = false, captainLive = true, stateDir = 'wake-state' } = {}) {
  const defs = [];
  const ctx = {
    logger: { warn: () => {}, debug: () => {}, error: () => {} },
    tools: { register: (d) => { defs.push(d); } },
    agents: { get: (id) => (captainLive && id === 'cap1' ? { id: 'cap1', session: { append: () => {} } } : undefined) },
    subagents: { followup: async () => { if (!followupOk) throw new Error('followup refused'); return true; } },
  };
  registerWakeRuntime(ctx, { kickMember: async (workspace, teamId, memberName) => { kicks.push(`${teamId}/${memberName}`); } });
  registerFlowTools(ctx, { stateDir, tddMode: 'enforce', maxCyclesPerTask: 12 }, { scheduler: {} });
  return {
    defs, ctx,
    navigator: { id: 'child-nav', session: { header: { cwd: root }, append: () => {} } },
    stateRoot: join(root, stateDir),
  };
}

export async function run(check) {
  const root = await mkdtemp(join(tmpdir(), 'pair-wake-'));
  try {
    // A: no scheduler registered -> scheduleWake is a no-op, never a throw.
    check(scheduleWake({ logger: { warn: () => {} } }, root, 't1', 'driver') === false, 'A scheduleWake without a registered scheduler reports false');

    // B: the registry is per-context, not a process singleton.
    const c1 = {}, c2 = {};
    registerWakeRuntime(c1, { kickMember: async () => {} });
    check(wakeRuntimeFor(c1) !== undefined && wakeRuntimeFor(c2) === undefined, 'B the wake registry is keyed by context, not global');

    // C: THE REGRESSION — a GO whose live delivery fails still wakes the Driver.
    const kicks = [];
    const h = stalledHarness(root, kicks);
    const team = teamFixture();
    openCycle(team.protocol, 't-1', { tddMode: 'enforce' });
    const cycleId = team.protocol.cycles[0].id;
    team.protocol.cycles[0].proposal = { intent: 'i', files: ['a.js'], verify_plan: 'p', at: 1 };
    await createTeamDir(h.stateRoot, team);
    const review = h.defs.find((d) => d.name === 'pair_review').execute;
    const res = await review({ cycle_id: cycleId, verdict: 'go', evidence: ['read a.js:1'] }, { agent: h.navigator });
    check(res.verdict === 'go' && res.delivered === 'mailbox', 'C the GO lands in the mailbox when the live wake is refused');
    await tick();
    check(kicks.includes('t1/driver'), 'C a mailbox-only GO schedules a recovery kick of the Driver (O3 regression)');
    check((await readTeam(h.stateRoot, 't1')).protocol.cycles[0].step === 'GO', 'C the board still advanced to GO');

    // D: a successful live wake needs no recovery kick (no double delivery).
    const kicks2 = [];
    const h2 = stalledHarness(root, kicks2, { followupOk: true, stateDir: 'wake-state-2' });
    const team2 = teamFixture({ id: 't2' });
    openCycle(team2.protocol, 't-1', { tddMode: 'enforce' });
    team2.protocol.cycles[0].proposal = { intent: 'i', files: ['a.js'], verify_plan: 'p', at: 1 };
    await createTeamDir(h2.stateRoot, team2);
    const res2 = await h2.defs.find((d) => d.name === 'pair_review').execute(
      { cycle_id: team2.protocol.cycles[0].id, verdict: 'go', evidence: ['read a.js:1'] },
      { agent: { id: 'child-nav', session: { header: { cwd: root }, append: () => {} } } },
    );
    await tick();
    check(res2.delivered === 'wake' && kicks2.length === 0, 'D a live wake does not also fire a recovery kick');

    // E: heartbeat sweeps tracked teams and drops finished ones.
    const hbRoot = join(root, 'hb-state');
    await createTeamDir(hbRoot, teamFixture({ id: 'h1' }));
    const finished = teamFixture({ id: 'h2' });
    finished.protocol.phase = 'DONE';
    await createTeamDir(hbRoot, finished);
    const swept = [];
    const ctx = { logger: { warn: () => {} }, on: () => {}, agents: { get: () => undefined }, subagents: {} };
    const scheduler = installPairScheduler(ctx, { stateDir: 'hb-state', heartbeatMs: 0 });
    scheduler.kickTeam = async (_workspace, teamId) => { swept.push(teamId); };
    scheduler.trackTeam(root, 'h1');
    scheduler.trackTeam(root, 'h1');
    scheduler.trackTeam(root, 'h2');
    scheduler.trackTeam(root, 'ghost');
    check(scheduler.trackedTeams().length === 3, 'E trackTeam is idempotent per (workspace, team)');
    await scheduler.heartbeat();
    check(swept.length === 1 && swept[0] === 'h1', 'E the heartbeat sweeps live teams and skips DONE/missing ones');
    check(scheduler.trackedTeams().length === 1, 'E finished and vanished teams are dropped from the sweep list');

    // G: settled teams leave the sweep list (all tasks terminal, all idle,
    // no mail, nothing owed) — a finished team costs zero future sweeps, and
    // every wake path re-tracks first, so the list is self-healing.
    const gRoot = join(root, 'g-state');
    const settled = teamFixture({ id: 's1' });
    settled.tasks = [{ id: 't-1', subject: 's', status: 'completed', dependencies: [], createdAt: 1, updatedAt: 1 }];
    await createTeamDir(gRoot, settled);
    await createTeamDir(gRoot, teamFixture({ id: 's2' }));
    const sweptG = [];
    const gctx = { logger: { warn: () => {} }, on: () => {}, agents: { get: () => undefined }, subagents: {} };
    const gsched = installPairScheduler(gctx, { stateDir: 'g-state', heartbeatMs: 0 });
    gsched.kickTeam = async (_workspace, teamId) => { sweptG.push(teamId); };
    gsched.trackTeam(root, 's1');
    gsched.trackTeam(root, 's2');
    await gsched.heartbeat();
    check(sweptG.length === 1 && sweptG[0] === 's2', 'G the heartbeat kicks live teams but not settled ones');
    check(gsched.trackedTeams().length === 1 && gsched.trackedTeams()[0].teamId === 's2', 'G settled teams leave the sweep list');
    scheduler.untrackTeam(root, 'h1');
    check(scheduler.trackedTeams().length === 0, 'E untrackTeam removes the last team');

    // F: task creation wakes with the WORKSPACE, not the state root (F4 regression:
    // kickTeam(stateRoot, ...) double-joined the state dir and silently woke nobody).
    const h3 = stalledHarness(root, [], { stateDir: 'wake-state-3' });
    await createTeamDir(h3.stateRoot, teamFixture({ id: 't3' }));
    const kicks3 = [];
    registerTaskTools(h3.ctx, { stateDir: 'wake-state-3' }, { scheduler: { kickTeam: async (ws, tid) => { kicks3.push(ws + '\0' + tid); } } });
    const create = h3.defs.find((d) => d.name === 'pair_task_create').execute;
    const created = await create({ subject: 'new story', legacy: true }, { agent: { id: 'cap1', session: { header: { cwd: root }, append: () => {} } } });
    check(typeof created.task_id === 'string' && created.task_id.length > 0, 'F the task is created');
    check(kicks3.length === 1 && kicks3[0] === root + '\0t3', 'F task creation kicks with the workspace so the scheduler resolves the real state dir');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
