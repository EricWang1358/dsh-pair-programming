/**
 * N5 liveness: a mailbox-only delivery must schedule its own recovery kick,
 * and the heartbeat must sweep tracked teams. The regression this pins is the
 * O3 stall — GO on the board, Driver never woken, timebox burned.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerWakeRuntime, wakeRuntimeFor, scheduleWake } from '../lib/runtime/wake.js';
import { wakeCaptain } from '../lib/tools/shared.js';
import { installPairScheduler } from '../lib/runtime/scheduler.js';
import { registerFlowTools } from '../lib/tools/flow.js';
import { registerTaskTools } from '../lib/tools/task.js';
import { createTeamDir, readTeam } from '../lib/state/store.js';
import { initialProtocolState, openCycle } from '../lib/protocol/machine.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

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

    // B2: a board event re-enters an idle captain; a running captain receives
    // a steer. Replaying the same board-revision/obligation edge is deduped.
    const idleCalls = []; const idleCaptain = { status: 'idle', followup: m => idleCalls.push(m), steer: () => { throw new Error('wrong path'); } };
    check(wakeCaptain(idleCaptain, 'navigator', '[PAIR:ACCEPT]', 't1:7:gate') === true && idleCalls.length === 1, 'B2 an idle captain is re-entered with followup');
    wakeCaptain(idleCaptain, 'navigator', '[PAIR:ACCEPT replay]', 't1:7:gate');
    check(idleCalls.length === 1, 'B2 the same board revision and obligation wakes the captain at most once');
    const steerCalls = []; const runningCaptain = { status: 'running', steer: m => steerCalls.push(m), followup: () => { throw new Error('wrong path'); } };
    check(wakeCaptain(runningCaptain, 'driver', '[PAIR:GREEN]', 't1:8:verify') === true && steerCalls.length === 1, 'B2 a running captain receives nearest-step steering');

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

    // H: the sweep nudges the seat that OWES the call, not only the captain.
    //
    // The measured stall: "Idle seats: driver, navigator, challenger. Mail
    // pending for: driver, navigator, challenger." — every seat idle, every
    // seat with mail, 244s of nothing. deliverProtocolMessage acknowledges the
    // mailbox the moment the host ACCEPTS a follow-up, so an accepted-but-inert
    // follow-up leaves the debt standing with an EMPTY inbox: the redelivery
    // branch finds nothing, the assignment branch finds no ready task, and the
    // sweep used to return silently. The only recovery was escalateIfStalled
    // steering the captain — which is why a live captain hand-relayed every
    // step, the one thing its own protocol text forbids.
    const hRoot = join(root, 'h-state');
    const owing = teamFixture({ id: 'n1', updatedAt: 4242 });
    const hCycle = openCycle(owing.protocol, 't-1', { tddMode: 'enforce' });
    hCycle.step = 'GREEN';
    hCycle.oracleSha = 'a'.repeat(64);
    await createTeamDir(hRoot, owing);
    const followups = [];
    const hctx = {
      logger: { warn: () => {}, debug: () => {} }, on: () => {},
      agents: { get: (id) => (id === 'cap1' ? { id: 'cap1', session: { append: () => {} } } : undefined) },
      subagents: { followup: async (_cap, childId, content) => { followups.push({ childId, text: content[0].text }); return true; } },
    };
    const hsched = installPairScheduler(hctx, { stateDir: 'h-state', heartbeatMs: 0 });
    await hsched.kickMember(root, 'n1', 'navigator');
    check(followups.length === 1 && followups[0]?.childId === 'child-nav', 'H the sweep wakes the seat that owes the step, directly — no captain in the loop');
    check(String(followups[0]?.text).includes('[PAIR:NEXT]') && String(followups[0]?.text).includes('pair_verify'), 'H and hands it the owed call verbatim off the board');
    check(String(followups[0]?.text).includes('YOU owe'), 'H in the second person, so the seat cannot read it as somebody else’s turn');
    await hsched.kickMember(root, 'n1', 'navigator');
    check(followups.length === 1, 'H one debt is one nudge — a 120s sweep must not become a 120s nag');
    await hsched.kickMember(root, 'n1', 'driver');
    // The Driver does get woken here, but by the pre-existing attempt-recovery
    // branch (it still owns an in-progress t-1), not by a debt nudge. Assert
    // the nudge specifically, or this passes for the wrong reason.
    check(followups.filter(f => f.text.includes('the board has been waiting on you')).length === 1,
      'H only the seat named by [PAIR:NEXT] is nudged — the Driver owes nothing here and gets its ordinary attempt recovery instead');

    // H2: when the host REFUSES the wake, the board must say so.
    //
    // This is the root-cause layer under every stall in this file. The host
    // throws a typed SubagentError — DRAINING while continuable subagents shut
    // down, ACTIVATION_CLOSING mid-disposal — and deliverToMember used to
    // swallow it into a logger.warn and return a bare false. The unread branch
    // then released the mail and returned WITHOUT recording anything, so the
    // sweep retried silently every 120s and the only artifact was a stall
    // report that could not name a cause. That is exactly what two live
    // sessions produced: "Mail pending for: driver, navigator, challenger",
    // 244s, and no why. The refusal now reaches the captain verbatim.
    const rRoot = join(root, 'r-state');
    const refusing = teamFixture({ id: 'r1', updatedAt: 99 });
    const rCycle = openCycle(refusing.protocol, 't-1', { tddMode: 'enforce' });
    rCycle.step = 'GREEN';
    rCycle.oracleSha = 'b'.repeat(64);
    // Older than STALL_AFTER_MS: the diagnosis is derived from the board's own
    // timestamps, never from a stored clock.
    rCycle.openedAt = Date.now() - 400_000;
    await createTeamDir(rRoot, refusing);
    const steers = [];
    const rctx = {
      logger: { warn: () => {}, debug: () => {} }, on: () => {},
      agents: { get: (id) => (id === 'cap1' ? { id: 'cap1', status: 'idle', followup: (m) => { steers.push(m.content[0].text); }, session: { append: () => {} } } : undefined) },
      subagents: { followup: async () => { throw new Error('continuable subagents are draining; the operation was not admitted'); } },
    };
    const rsched = installPairScheduler(rctx, { stateDir: 'r-state', heartbeatMs: 0 });
    await rsched.kickMember(root, 'r1', 'navigator');
    await rsched.escalateIfStalled(root, 'r1');
    const reported = steers.join(String.fromCharCode(10));
    check(reported.includes('Why the sweep could not clear it'), 'H2 a sweep that could not move anything says so to the one party able to act');
    check(reported.includes('draining'), 'H2 and carries the host refusal verbatim — the difference between "went quiet" and "went quiet BECAUSE"');
    check(reported.includes('navigator'), 'H2 naming which seat could not be woken');

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

    // H: member status is an auditable turn summary, and a growing session seq
    // renews a long turn instead of consuming a captain/goal round.
    const teleRoot = join(root, 'tele-state');
    await createTeamDir(teleRoot, teamFixture({ id: 'tele' }));
    const handlers = new Map(); const captainWakes = [];
    const child = {
      id: 'child-driver', status: 'running',
      session: { header: { cwd: root }, seq: 3, snapshotEvents: () => [] },
    };
    const captain = { id: 'cap1', status: 'idle', session: { header: { cwd: root } }, followup: msg => captainWakes.push(msg) };
    const tctx = {
      logger: { warn: () => {} }, on: (name, fn) => handlers.set(name, fn),
      agents: { get: id => id === child.id ? child : id === captain.id ? captain : undefined }, subagents: {},
    };
    const ts = installPairScheduler(tctx, { stateDir: 'tele-state', heartbeatMs: 0, workingLeaseMs: 600_000 });
    handlers.get('agent/status')({ agent: child, status: 'running' });
    await settle();
    let tele = await readTeam(teleRoot, 'tele');
    check(tele.members[0].status === 'working' && typeof tele.members[0].activity?.startedAt === 'number', 'H running records a renewable activity lease on the board');
    const sampledAt = tele.members[0].activity?.lastActivityAt ?? 0;
    child.session.seq = 9;
    await ts.sampleMemberActivity(root, 'tele');
    tele = await readTeam(teleRoot, 'tele');
    check(tele.members[0].activity.lastSeq === 9 && tele.members[0].activity.lastActivityAt >= sampledAt, 'H new durable session events renew a long working turn');
    child.status = 'idle';
    child.session.snapshotEvents = () => [
      { type: 'tool/call', data: { name: 'pair_oracle' } },
      { type: 'tool/call', data: { name: 'read' } },
      { type: 'turn/end', data: { reason: 'completed' } },
    ];
    handlers.get('agent/status')({ agent: child, status: 'idle' });
    await settle();
    tele = await readTeam(teleRoot, 'tele');
    check(tele.members[0].lastTurn?.endReason === 'completed' && tele.members[0].lastTurn.toolCalls === 2 && tele.members[0].lastTurn.boardMutations === 1, 'H idle records end reason, total tools, and protocol mutations instead of flattening every outcome to idle');
    handlers.get('agent/error')({ agent: child, error: new Error('oracle crashed') });
    await settle();
    tele = await readTeam(teleRoot, 'tele');
    check(tele.members[0].lastTurn?.endReason === 'error' && tele.members[0].lastTurn.lastError.includes('oracle crashed'), 'H member errors persist a captain-visible last-error summary');
    check(captainWakes.length === 1, 'H a member error re-enters an idle captain once');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
