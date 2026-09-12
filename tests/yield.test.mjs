/**
 * B5 escape hatch: pair_yield.
 *
 * Measured (sg-career session, twice): "[PAIR:STALL] … 299s without board
 * progress". The Captain owed a structurally impossible pair_integrate (the
 * integration environment was missing runtime data) while a new task t-4 —
 * independent scope, ready, unclaimed — was never dispatched and all four
 * seats sat idle. Nothing in the protocol let a captain say "I cannot execute
 * this" except by writing another board event, which is what it did three
 * times. This pins the explicit version of that move: give the obligation up,
 * record why, and let the frontier dispatch the work that is still ready.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamDir, readTeam } from '../lib/state/store.js';
import { initialProtocolState, openCycle } from '../lib/protocol/machine.js';
import { gateStateFingerprint } from '../lib/protocol/gate.js';
import * as obligations from '../lib/protocol/obligation.js';

const scope = (writes) => ({ writes, reads: [], resources: [], declared: true });

function parallelBoard() {
  const board = {
    id: 'obp', name: 'OBP', goal: 'g', mode: 'full', tddMode: 'enforce', pairStyle: 'traditional',
    captainSessionId: 'cap1', createdAt: 1, updatedAt: 1,
    parallel: { workspace: 'C:/ws', stateRoot: 'C:/ws/.pair-programming', stateRelative: '.pair-programming/parallel',
      slots: { driver: { path: 'C:/ws/d1', branch: 'b1' }, driver2: { path: 'C:/ws/d2', branch: 'b2' } }, integrations: {} },
    members: [
      { id: 'c-d1', name: 'driver', role: 'driver', status: 'idle', joinedAt: 1 },
      { id: 'c-d2', name: 'driver2', role: 'driver', status: 'idle', joinedAt: 1 },
      { id: 'c-nav', name: 'navigator', role: 'navigator', status: 'idle', joinedAt: 1 },
      { id: 'c-chal', name: 'challenger', role: 'challenger', status: 'idle', joinedAt: 1 },
    ],
    tasks: [
      { id: 't-1', subject: 'candidate awaiting integration', status: 'in_progress', assignee: 'driver2', attemptId: 'a-1',
        dependencies: [], createdAt: 1, updatedAt: 1, scope: scope(['lib/a.js']) },
      { id: 't-4', subject: 'independent scope', status: 'pending', dependencies: [], createdAt: 2, updatedAt: 2, scope: scope(['lib/b.js']) },
    ],
    taskSeq: 4, protocol: { ...initialProtocolState(), phase: 'CYCLING' }, evidenceStats: { cacheHits: 0, cacheMiss: 0 },
  };
  const done = openCycle(board.protocol, 't-1', { tddMode: 'enforce' });
  done.verify = { verdict: 'accept', at: 5 };
  board.protocol.gatePasses.push({ id: 'g-1', taskId: 't-1', at: 6, binding: {
    gateStateSha: gateStateFingerprint(board, 't-1'),
    taskAttempt: { attemptId: 'a-1', assignee: 'driver2' }, worktreeSha: 'w'.repeat(40) } });
  board.tasks[0].gatePassId = 'g-1';
  return board;
}

export async function run(check) {
  const root = await mkdtemp(join(tmpdir(), 'pair-yield-'));
  const stateRoot = join(root, 'yield-state');
  try {
    const board = parallelBoard();
    await createTeamDir(stateRoot, board);
    const defs = [], kicks = [];
    const captain = { id: 'cap1', status: 'idle', session: { header: { cwd: root }, append: () => {} } };
    const ctx = {
      logger: { warn: () => {}, debug: () => {}, error: () => {} },
      tools: { register: (d) => defs.push(d) },
      agents: { get: (id) => (id === 'cap1' ? captain : undefined) },
      subagents: { sendMessage: async () => 'm-1' },
    };
    let registerYieldTools;
    // Guarded import: the API this file exists to demand is the one it must be
    // able to report missing by name instead of crashing the whole suite.
    try { ({ registerYieldTools } = await import('../lib/tools/yield.js')); } catch { registerYieldTools = undefined; }
    check(typeof registerYieldTools === 'function', 'Y pair_yield exists as a first-class tool, not as a prose convention');
    if (registerYieldTools === undefined) return;
    registerYieldTools(ctx, { stateDir: 'yield-state', oracleFirst: true },
      { scheduler: { kickTeam: async (workspace, teamId) => { kicks.push(workspace + '\0' + teamId); } } });
    const yieldTool = defs.find(d => d.name === 'pair_yield')?.execute;
    check(typeof yieldTool === 'function' && String(defs.find(d => d.name === 'pair_yield')?.description).includes('give up'),
      'Y and it is registered with a description that says what it is for');

    const before = await readTeam(stateRoot, 'obp');
    const fingerprint = gateStateFingerprint(before, 't-1');
    check(obligations.nextObligation(before)?.tool === 'pair_integrate' && obligations.nextObligation(before)?.who === 'captain',
      'Y precondition: the frontier is held by the Captain’s own obligation while a ready independent card waits');

    // Checked BEFORE the yield, while the Captain still holds a real debt: the
    // refusal has to name what it actually owes, or a Captain that mistyped a
    // tool cannot tell "you owe something else" from "you owe nothing".
    let foreign;
    try { await yieldTool({ tool: 'pair_verify', reason: 'I do not want to verify this' }, { agent: captain }); foreign = 'no throw'; }
    catch (error) { foreign = String(error?.message ?? error); }
    check(foreign.includes('pair_verify') && foreign.includes('pair_integrate') && foreign.includes('t-1'),
      'Y a Captain cannot yield a member’s step, and the refusal names the obligation it does hold');

    const res = await yieldTool({ tool: 'pair_integrate', task_id: 't-1', reason: 'the integration environment is missing the runtime data' },
      { agent: captain });
    check(res.yielded?.tool === 'pair_integrate' && res.yielded?.taskId === 't-1' && String(res.yielded?.reason).includes('missing the runtime data'),
      'Y the Captain gives the obligation up and the reason is recorded with it');
    const after = await readTeam(stateRoot, 'obp');
    check((after.protocol.yields ?? []).length === 1 && after.protocol.yields[0].at > 0,
      'Y the yield is durable board state, not a turn-local gesture');
    check(obligations.yieldedObligations(after).length === 1, 'Y the yielded obligation stays readable for pair_status');
    check(!obligations.obligationFrontier(after).some(o => o.tool === 'pair_integrate'), 'Y the frontier stops reporting the obligation the Captain cannot execute');
    // #150: the receipt has to say what is left. A line that stops after the yield reads as "you
    // owe nothing" beside a board whose attention list is full -- two different lists, and the tool
    // never said so.
    const def = defs.find(d => d.name === 'pair_yield');
    const text = (value) => def.output.render({}, value)[0].text;
    const withRest = text({ already_yielded: false, yielded: { tool: 'pair_integrate', ref: 't-1', reason: 'no runtime data' }, frontier: ['captain owes pair_gate_check(t-2)', 'navigator owes pair_oracle(t-3)'] });
    check(withRest.includes('Still owed:') && withRest.includes('pair_gate_check(t-2)') && withRest.includes('pair_oracle(t-3)'),
      '#150 the receipt names every obligation still owed, and by whom');
    const clear = text({ already_yielded: false, yielded: { tool: 'pair_integrate', ref: 't-1', reason: 'no runtime data' }, frontier: [] });
    check(clear.includes('TOOL CALL') && clear.includes('attention') && clear.includes('blocking risk'),
      '#150 and when nothing is left it says which list it is talking about instead of implying the board is clear');
    check(text({ already_yielded: true, yielded: { tool: 'pair_integrate', ref: 't-1', reason: 'r' } }).includes('already yielded'),
      '#150 while the idempotent path keeps its own wording');
    check(obligations.nextObligation(after)?.tool === 'pair_task_claim' && obligations.nextObligation(after)?.taskId === 't-4',
      'Y and other ready work becomes the board’s next move instead of idling behind it');
    check(kicks.length === 1 && kicks[0] === root + '\0obp', 'Y the yield dispatches the team so the newly-ready work actually starts');
    check(gateStateFingerprint(after, 't-1') === fingerprint,
      'Y giving up an obligation is not a gate input: the card’s credential is untouched');

    const again = await yieldTool({ tool: 'pair_integrate', task_id: 't-1', reason: 'the integration environment is missing the runtime data' },
      { agent: captain });
    check(again.already_yielded === true && (await readTeam(stateRoot, 'obp')).protocol.yields.length === 1,
      'Y yielding the same obligation twice is idempotent — one record, not a growing pile of identical rulings');


    let intruder;
    try { await yieldTool({ tool: 'pair_integrate', reason: 'not mine to give up' }, { agent: { id: 'c-d1', session: { header: { cwd: root }, append: () => {} } } }); intruder = 'no throw'; }
    catch (error) { intruder = String(error?.message ?? error); }
    check(intruder.toLowerCase().includes('captain'), 'Y only the Captain may yield a Captain obligation');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
