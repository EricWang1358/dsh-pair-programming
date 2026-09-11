/**
 * The checkout has ONE owner, and the owner is a BOARD, not a loaded session.
 *
 * Plan section J2, measured by review: the availability check asked whether any of a
 * team's sessions was currently loaded. After a host restart none of them is — so an
 * unrelated team started happily in a checkout a live board already owned, and
 * reopening the first team's conversation then auto-tracked it, restored its members,
 * and put two teams on one production workspace. A loaded-session test cannot see a
 * board that is merely not in memory yet.
 *
 * These cases are event- and scheduler-level only: no model call, no host SDK.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamDir, inspectTeams } from '../lib/state/store.js';
import { workspaceOwner } from '../lib/state/ownership.js';
import { requireWorkspaceAvailable } from '../lib/tools/resume.js';
import { initialProtocolState } from '../lib/protocol/machine.js';
import { installPairScheduler } from '../lib/runtime/scheduler.js';

function board(id, captainSessionId, phase = 'CYCLING') {
  return { id, artifactNamespace: 'ns-' + id, name: id, goal: 'ownership fixture', mode: 'light', tddMode: 'enforce', pairStyle: 'traditional',
    captainSessionId, createdAt: 1, updatedAt: 1, members: [], tasks: [], taskSeq: 0,
    protocol: { ...initialProtocolState(), phase } };
}
/** A context that looks like a restarted host: nothing is loaded. */
const coldCtx = () => ({ agents: { get: () => undefined }, logger: { warn() {} } });

export async function run(check) {
  const root = await mkdtemp(join(tmpdir(), 'pair-ownership-'));
  const state = join(root, 'state');
  try {
    // ---- the owner is judged from disk, with no session loaded --------------
    await createTeamDir(state, board('live-a', 'cap-a'));
    await createTeamDir(state, board('archived', 'cap-x', 'DONE'));
    const owner = await workspaceOwner(state);
    check(owner?.teamId === 'live-a', 'J2 an open board owns the checkout even when no session is loaded (the restart hole)');
    check((await workspaceOwner(state, 'live-a')) === undefined, 'J2 a team is never its own obstacle: the excepted board owns nothing out');
    check((await workspaceOwner(state, 'archived'))?.teamId === 'live-a', 'J2 a terminal archive does not count as an owner, and does not release the live one');

    await assert.rejects(() => requireWorkspaceAvailable(coldCtx(), state), /PAIR_WORKSPACE_BUSY: team live-a/);
    check(true, 'J2 starting a second team is refused on the cold host, naming the occupant');
    check((await requireWorkspaceAvailable(coldCtx(), state, 'live-a')) === undefined, 'J2 and the owning team itself is allowed through');
    let refusal = '';
    try { await requireWorkspaceAvailable(coldCtx(), state, 'someone-else'); } catch (error) { refusal = String(error.message); }
    check(refusal.includes('PAIR_WORKSPACE_BUSY') && refusal.includes('pair_stop') && refusal.includes('resume_team'), 'J2 the refusal names the occupant AND both ways to hand the checkout over');

    // P1 (reviewer, HEAD 9a0ca54): inspectTeams reports a PARTIAL scan through
    // { errors, complete } instead of throwing, and that used to be read as 'nobody owns
    // this checkout' - the same fail-open the unreadable case below refuses.
    const corruptDir = join(root, 'corrupt');
    await createTeamDir(corruptDir, board('healthy', 'cap-h'));
    await mkdir(join(corruptDir, 'broken'), { recursive: true });
    await writeFile(join(corruptDir, 'broken', 'team.json'), '{');
    const corruptOwner = await workspaceOwner(corruptDir);
    check(corruptOwner !== undefined && String(corruptOwner.teamId).includes('broken'),
      'J2 a partial scan is unknown occupancy, not an empty checkout: it refuses and names the unreadable board');
    await assert.rejects(() => requireWorkspaceAvailable(coldCtx(), corruptDir), /PAIR_WORKSPACE_BUSY: .*broken/,
      'J2 and starting a team there is refused for that reason rather than allowed');

    // ---- an unreadable state tree must not license a second team ------------
    const broken = join(root, 'not-a-directory');
    await writeFile(broken, 'this path is a file, so the state tree cannot be listed');
    const brokenOwner = await workspaceOwner(broken);
    check(brokenOwner !== undefined, 'J2 a state path that cannot be listed refuses rather than licensing a second writer');
    check(brokenOwner?.phase === 'unknown', 'J2 and it reports the unknown occupant as unknown rather than guessing');

    // ---- reopened conversation: no member is tracked while another owns it ---
    const shared = join(root, 'shared');
    await createTeamDir(shared, board('team-a', 'cap'));
    await createTeamDir(shared, board('team-b', 'cap-b'));
    const handlers = new Map();
    const warnings = [];
    const ctx = { on: (n, f) => handlers.set(n, f), logger: { warn: v => warnings.push(String(v)) }, agents: { get: () => undefined }, subagents: {} };
    const scheduler = installPairScheduler(ctx, { stateDir: 'shared', heartbeatMs: 0 });
    await handlers.get('agent/session-start')({ agent: { id: 'cap', session: { header: { cwd: root } } } });
    check(scheduler.trackedTeams().length === 0, 'J2 reopening team A does not track it while team B owns the checkout, so no member is woken into it');
    check(warnings.some(v => v.includes('team-b') && v.includes('PAIR_WORKSPACE_BUSY')), 'J2 and the refusal names the occupant and the way out');
    handlers.get('dispose')();

    // ---- both boards stay readable ------------------------------------------
    const scan = await inspectTeams(shared);
    check(scan.teams.length === 2 && scan.errors.length === 0, 'J2 both boards remain readable for inspection while the conflict stands');

    // ---- after the occupant is released, resumption works -------------------
    await createTeamDir(shared, board('team-b', 'cap-b', 'ABORTED'));
    const handlers2 = new Map();
    const ctx2 = { on: (n, f) => handlers2.set(n, f), logger: { warn() {} }, agents: { get: () => undefined }, subagents: {} };
    const scheduler2 = installPairScheduler(ctx2, { stateDir: 'shared', heartbeatMs: 0 });
    await handlers2.get('agent/session-start')({ agent: { id: 'cap', session: { header: { cwd: root } } } });
    check(scheduler2.trackedTeams().map(t => t.teamId).join(',') === 'team-a', 'J2 once the occupant is terminal, the original conversation is rediscovered and tracked again');
    handlers2.get('dispose')();
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}
