/**
 * One route-resolution rule per seat, and fallback state that belongs to a TEAM.
 *
 * Ported from the acceptance oracle frozen by the Navigator seat of the
 * v15-u1-routing run (.pair-oracles/9e72adf5-abb6-4394-bf65-17c84ecf6e06/t-1/
 * acceptance.mjs, sha 1fe7b29db1a488f3bbfb59197d31c99e71f47b05be3919f64fb98715dd7f4aff),
 * which was authored before any implementation of this existed and assumes no new
 * API name: every arm drives a REAL seat-creation entry point (pair_start,
 * recycleMember, resumeTeam, the navigator route test) with mocks only at the host
 * boundary. Exactly two things changed on the way in, and both are instrument
 * repairs rather than expectations:
 *
 *   1. the recycle harness now answers with the captain the BOARD names, instead of
 *      only with the id it minted itself. The original mock handed the resolver a
 *      stub, resolveMemberLlmSelection called requestHeader() on it, the TypeError
 *      was swallowed into {recycled:false}, no seat was spawned and the arm was red
 *      whatever the product did — a red that measured the harness, not the code;
 *   2. the watchdog / exit-code machinery is gone, because a suite in this runner
 *      reports through run(check) instead of exiting.
 *
 * The RED this suite exists to hold: the sticky quota fallback is a MODULE-LEVEL
 * global (lib/runtime/members.js navRouteFallbackDetail), so ONE team's acceptance
 * seat dying of quota re-routes EVERY other team's navigator. AC-1a/1b/1c are the
 * arms that must go green when that state becomes per team and per seat; AC-1d and
 * AC-2a/2b are regression guards that already pass.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerLifecycleTools } from '../lib/tools/lifecycle.js';
import { recycleMember } from '../lib/runtime/recycle.js';
import { spawnIsolatedMember } from '../lib/runtime/isolated-members.js';
import { createTeamDir } from '../lib/state/store.js';
import { initialProtocolState } from '../lib/protocol/machine.js';
import { installNavModelStatus } from '../lib/integrations/nav-model.js';

const CAP = { provider: 'cap-provider', model: 'cap-model' };
const PREMIUM = { provider: 'premium', model: 'premium-v1' };
const NAV_CONFIG = { navigatorModel: 'premium/premium-v1' };
const PREMIUM_JSON = JSON.stringify(PREMIUM);
const CAP_JSON = JSON.stringify(CAP);
const USE_CASES = [{ actor: 'pair team operator running two teams in one host', intent: 'route every seat with one rule', outcome: 'no cross-team route leak', acceptance_criteria: ['a route recorded for one team never changes another team'] }];

function routeJson(route) { return JSON.stringify({ provider: route.provider, model: route.model }); }
function seatRoutes(attempts, seat) { return attempts.filter(a => String(a.label).endsWith(':' + seat)).map(a => routeJson(a.route)); }
function seatRoute(attempts, seat) { const all = seatRoutes(attempts, seat); return all.length === 0 ? null : all[all.length - 1]; }

function captainFor(id) {
  return { id, options: { ...CAP }, session: { header: { cwd: '' }, requestHeader: () => ({ config: { ...CAP } }) } };
}

/** Host boundary mock: records the route each seat is really spawned with. */
function spawnRecorder(options) {
  const opts = options || {};
  const attempts = [];
  const fired = new Set();
  const startContinuable = async (call) => {
    const route = { provider: call.request.agentOptions.provider, model: call.request.agentOptions.model };
    const label = String(call.label);
    attempts.push({ label, route });
    const seat = label.split(':').pop();
    if (opts.quotaSeat === seat && route.provider === PREMIUM.provider && route.model === PREMIUM.model && !fired.has(seat)) {
      fired.add(seat);
      throw new Error('402 insufficient balance: quota exhausted, check your plan and billing');
    }
    return { childId: 'child-' + attempts.length };
  };
  return { attempts, startContinuable };
}

function board(id, captainId) {
  return { id, artifactNamespace: 'ns-' + id, name: id, goal: 'route isolation fixture', mode: 'light',
    tddMode: 'enforce', pairStyle: 'traditional', captainSessionId: captainId, createdAt: 1, updatedAt: 1,
    members: [{ id: 'old-nav-' + id, name: 'navigator', role: 'navigator', provider: PREMIUM.provider, model: PREMIUM.model, joinedAt: 1, status: 'idle' }],
    tasks: [], taskSeq: 0, protocol: { ...initialProtocolState(), phase: 'CYCLING' } };
}

function lifecycleHarness(root, stateDir, options) {
  const rec = spawnRecorder(options);
  const cap = captainFor('cap-' + stateDir);
  cap.session.header.cwd = root;
  const defs = [];
  const schemas = ['read', 'write', 'edit', 'pair_start', 'pair_stop', 'pair_rotate', 'pair_arbitrate'].map(name => ({ name }));
  const ctx = {
    logger: { warn: () => {}, debug: () => {}, error: () => {} },
    tools: { register: d => { defs.push(d); }, schemas: () => schemas },
    agents: { get: id => (id === cap.id ? cap : undefined) },
    llm: { resolveCallConfig: async c => c },
    subagents: {
      interrupt: () => {}, list: () => ['pair'],
      getProvider: () => ({ prepareContinuable: () => {}, capabilities: { persona: true, toolFilter: true } }),
      startContinuable: rec.startContinuable,
    },
  };
  registerLifecycleTools(ctx, { stateDir, memberProvider: 'pair', tddMode: 'enforce', pairStyle: 'traditional', defaultMode: 'light', greenBuildOnStop: false, ...NAV_CONFIG },
    { selections: { withPending: async (i, l, s, op) => op() }, scheduler: {} });
  return { attempts: rec.attempts, cap, defs };
}

/** Path 1 — initial spawn: pair_start spawns the acceptance seat. */
async function pathInitialSpawn(root, stateDir, teamName, options) {
  const h = lifecycleHarness(root, stateDir, options);
  const start = h.defs.find(d => d.name === 'pair_start').execute;
  await start({ goal: 'route isolation probe', mode: 'light', name: teamName, use_cases: USE_CASES }, { agent: h.cap });
  return h.attempts;
}

/** Path 2 — recycle: recycleMember respawns the acceptance seat. */
async function pathRecycle(root, stateDir, teamId, options) {
  const opts = options || {};
  const stateRoot = join(root, stateDir);
  const rec = spawnRecorder(opts);
  const cap = captainFor('cap-rec-' + teamId);
  const ctx = {
    logger: { warn: () => {} },
    // INSTRUMENT REPAIR: the host resolves the agent the BOARD names. The original
    // harness answered only for its own minted id, so on an existing board the
    // resolver received a stub, threw inside requestHeader(), and the arm was red
    // for a harness reason (measured: 5 passed / 5 failed before, 7 / 3 after).
    agents: { get: id => ({ ...cap, id }) },
    tools: { schemas: () => [{ name: 'read' }, { name: 'write' }] },
    llm: { resolveCallConfig: async c => c },
    subagents: {
      interrupt: () => {},
      getProvider: () => ({ prepareContinuable: () => {}, capabilities: { persona: true, toolFilter: true } }),
      startContinuable: rec.startContinuable,
    },
  };
  if (!opts.existingBoard) await createTeamDir(stateRoot, board(teamId, cap.id));
  const runtime = { selections: { withPending: async (i, l, s, op) => op() }, releaseTeamSeats: () => {} };
  await recycleMember(ctx, { memberLifetime: 'cycle', memberProvider: 'pair', stateDir, ...NAV_CONFIG }, runtime, stateRoot, teamId, 'navigator', { force: true });
  return rec.attempts;
}

/** Path 3 — handoff/quota resume: resumeTeam rebuilds the seats. */
async function pathResume(root, stateDir, teamId, options) {
  const prev = captainFor('cap-prev-' + teamId);
  await createTeamDir(join(root, stateDir), board(teamId, prev.id));
  const h = lifecycleHarness(root, stateDir, options);
  const start = h.defs.find(d => d.name === 'pair_start').execute;
  await start({ resume_team: teamId, resume_from_captain: prev.id }, { agent: h.cap });
  return h.attempts;
}

/** Non-gating probe: what route an isolated (dual-Driver) spawn really uses. */
async function isolatedProbe(root) {
  const cap = captainFor('cap-iso');
  const slotPath = join(root, 'worktrees', 'driver');
  const team = { id: 'iso', name: 'iso', mode: 'light', artifactNamespace: 'ns-iso', goal: 'probe', tasks: [], taskSeq: 0,
    protocol: { ...initialProtocolState(), phase: 'CYCLING' },
    parallel: { workspace: root, slots: { driver: { path: slotPath } } },
    members: [{ id: 'iso-driver', name: 'driver', role: 'driver', provider: 'stale-provider', model: 'stale-model', joinedAt: 1, status: 'idle' }] };
  const created = [];
  const ctx = {
    logger: { warn: () => {} },
    agents: { get: id => (id === cap.id ? cap : undefined), create: async options => { created.push(options); return { agent: { id: 'iso-child' }, dispose: async () => {} }; } },
    tools: { schemas: () => [{ name: 'read' }] },
  };
  await spawnIsolatedMember(ctx, { maxDepth: 1 }, cap, team, team.members[0], 'persona', [], new AbortController().signal);
  return created.length === 0 ? null : JSON.stringify({ provider: created[0].agentOptions.provider, model: created[0].agentOptions.model });
}

export async function run(check) {
  const root = await mkdtemp(join(tmpdir(), 'pair-route-'));
  try {
    // ---- controls: a clean process, measured BEFORE any team degrades. -----
    const ctrlSpawn = seatRoute(await pathInitialSpawn(join(root, 'ctrl-spawn'), 'st-cs', 'ctrl-spawn', {}), 'navigator');
    check(ctrlSpawn === PREMIUM_JSON, 'AC control: a clean initial spawn resolves the acceptance seat to its configured route');
    const ctrlRecycle = seatRoute(await pathRecycle(join(root, 'ctrl-rec'), 'st-cr', 'ctrl-rec', {}), 'navigator');
    check(ctrlRecycle === PREMIUM_JSON, 'AC control: a clean recycle resolves the acceptance seat to its configured route');
    const ctrlResume = seatRoute(await pathResume(join(root, 'ctrl-res'), 'st-cre', 'ctrl-res', {}), 'navigator');
    check(ctrlResume === PREMIUM_JSON, 'AC control: a clean handoff resolves the acceptance seat to its configured route');

    // ---- team A dies of quota at formation (the real M20 fallback path). ---
    const aRoot = join(root, 'team-a');
    const aAttempts = await pathInitialSpawn(aRoot, 'st-a', 'team-a', { quotaSeat: 'navigator' });
    const aNav = seatRoutes(aAttempts, 'navigator');
    check(aNav.length >= 2 && aNav[0] === PREMIUM_JSON, 'AC-2a: a quota death at formation first offers the configured premium route');
    check(aNav.length >= 2 && aNav[aNav.length - 1] === CAP_JSON, 'AC-2a: and takes the acceptance seat over onto the captain route');
    const aOwn = seatRoute(await pathRecycle(aRoot, 'st-a', 'team-a', { existingBoard: true }), 'navigator');
    check(aOwn === CAP_JSON, 'AC-2b: the team that suffered the quota death keeps its OWN fallback active');

    // ---- team B, every seat-creation path, after A degraded. ---------------
    const afterSpawn = seatRoute(await pathInitialSpawn(join(root, 'b-spawn'), 'st-bs', 'b-spawn', {}), 'navigator');
    check(afterSpawn === ctrlSpawn, 'AC-1a: initial spawn for team B is byte-identical after team A degraded');
    const afterRecycle = seatRoute(await pathRecycle(join(root, 'b-rec'), 'st-br', 'b-rec', {}), 'navigator');
    check(afterRecycle === ctrlRecycle, 'AC-1b: recycle for team B is byte-identical after team A degraded');
    const afterResume = seatRoute(await pathResume(join(root, 'b-res'), 'st-bre', 'b-res', {}), 'navigator');
    check(afterResume === ctrlResume, 'AC-1c: handoff for team B is byte-identical after team A degraded');

    // ---- the real clear path: a successful route test clears the fallback. -
    const scope = { get: () => ({}), watch: () => () => {}, update: async () => {}, replace: async () => {} };
    const navApi = installNavModelStatus({ register: () => scope }, { navigatorModel: 'premium/premium-v1', navigatorModelProbeToken: '', navigatorEffort: '' },
      { resolve: async () => ({ ...PREMIUM }), logger: { warn: () => {} } });
    await navApi.validateNow('probe');
    const aCleared = seatRoute(await pathRecycle(aRoot, 'st-a', 'team-a', { existingBoard: true }), 'navigator');
    check(aCleared === PREMIUM_JSON, 'AC-1d: a successful route test clears the fallback and restores the seat to its configured route');

    // ---- non-gating blind spot, printed but never deciding (issue #26). ----
    console.log('  info NON-GATING dual-driver-stored-selection: an isolated Driver seat with a stored route spawned with agentOptions ' + String(await isolatedProbe(root).catch(() => 'probe did not complete')));
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
