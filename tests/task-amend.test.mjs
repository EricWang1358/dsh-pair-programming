/** Planning-card amendments: correct the contract without spending arbitration. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTaskTools } from '../lib/tools/task.js';
import { createTeamDir, readTeam, writeTeam } from '../lib/state/store.js';
import { initialProtocolState } from '../lib/protocol/machine.js';

const fails = (fn) => fn().then(() => '', error => String(error?.message ?? error));
const member = { id: 'driver-id', name: 'driver', role: 'driver', status: 'working', joinedAt: 1 };

function fixture() {
  return {
    id: 'amend', name: 'Amend', goal: 'correct a stale task', mode: 'light', captainSessionId: 'cap',
    createdAt: 1, updatedAt: 1, members: [structuredClone(member)], taskSeq: 2,
    useCases: [{ id: 'UC-1', actor: 'maintainer', intent: 'repair', outcome: 'ship', acceptanceCriteria: [
      { id: 'UC-1.AC-1', text: 'new command is used' }, { id: 'UC-1.AC-2', text: 'artifact is present' },
    ] }],
    tasks: [
      {
        id: 't-1', subject: 'old npm command', status: 'claimed', assignee: 'driver', attemptId: 'attempt-old',
        dependencies: [], acceptanceRefs: ['UC-1.AC-1'], deliverables: ['old.txt'],
        story: { role: 'maintainer', intent: 'run npm', benefit: 'avoid a broken release', acceptance_criteria: ['npm succeeds'] },
        oracle: { sha: 'a'.repeat(64), files: ['.pair-oracles/t-1/a.mjs'], caseRefs: ['UC-1.AC-1'] },
        createdAt: 1, updatedAt: 1,
      },
      { id: 't-2', subject: 'dependency', status: 'pending', dependencies: [], createdAt: 1, updatedAt: 1 },
    ],
    protocol: initialProtocolState(), evidenceStats: { cacheHits: 0, cacheMiss: 0 },
  };
}

function harness(root) {
  const defs = []; const kicks = [];
  const ctx = {
    logger: { warn() {}, debug() {} }, tools: { register: def => defs.push(def) },
    agents: { get: () => undefined }, subagents: {},
  };
  registerTaskTools(ctx, { stateDir: 'state' }, { scheduler: { kickTeam: async (workspace, teamId) => kicks.push({ workspace, teamId }) } });
  const session = id => ({ id, session: { header: { cwd: root }, append() {} } });
  return { tool: name => defs.find(def => def.name === name).execute, captain: session('cap'), driver: session('driver-id'), stateRoot: join(root, 'state'), kicks };
}

export async function run(check) {
  const root = await mkdtemp(join(tmpdir(), 'pair-amend-'));
  try {
    const h = harness(root);
    await createTeamDir(h.stateRoot, fixture());
    const denied = await fails(() => h.tool('pair_task_amend')({ task_id: 't-1', reason: 'wrong command', subject: 'new command' }, { agent: h.driver }));
    check(denied.includes('only the captain'), 'task amend is a captain-owned contract change');

    const amended = await h.tool('pair_task_amend')({
      task_id: 't-1', reason: 'the npm-era command is stale', subject: 'current build command',
      intent: 'run the current build', acceptance_criteria: ['current build succeeds'],
      acceptance_refs: ['UC-1.AC-1', 'UC-1.AC-2'], deliverables: ['dist/report.json'], dependencies: ['t-2'],
    }, { agent: h.captain });
    const board = await readTeam(h.stateRoot, 'amend');
    const task = board.tasks[0];
    check(amended.revision === 2 && amended.oracle_invalidated && amended.attempt_invalidated, 'task amend reports every invalidated contract view');
    check(task.status === 'pending' && task.attemptId === undefined && task.oracle === undefined && board.members[0].status === 'idle', 'task amend revokes a live attempt and frozen oracle atomically');
    check(task.subject === 'current build command' && task.story.acceptance_criteria[0] === 'current build succeeds' && task.deliverables[0] === 'dist/report.json', 'task amend replaces story and deliverable fields');
    check(task.acceptanceRefs.length === 2 && task.dependencies[0] === 't-2' && task.amendments[0].reason.includes('npm-era'), 'task amend persists goal allocation, dependencies, and its audit reason');
    check(h.kicks.length === 1 && h.kicks[0].workspace === root && h.kicks[0].teamId === 'amend', 'task amend wakes the real workspace board');

    const noChange = await fails(() => h.tool('pair_task_amend')({ task_id: 't-1', reason: 'repeat', subject: ' current build command ' }, { agent: h.captain }));
    check(noChange.includes('no semantic change'), 'task amend refuses audit noise with no semantic change');
    const self = await fails(() => h.tool('pair_task_amend')({ task_id: 't-1', reason: 'bad edge', dependencies: ['t-1'] }, { agent: h.captain }));
    check(self.includes('cannot depend on itself'), 'task amend refuses a self dependency');

    const scheduled = await readTeam(h.stateRoot, 'amend');
    scheduled.tasks[0].oracle = { sha: 'b'.repeat(64), files: ['.pair-oracles/t-1/a.mjs'], caseRefs: ['UC-1.AC-1', 'UC-1.AC-2'] };
    await writeTeam(h.stateRoot, scheduled);
    const deliveryOnly = await h.tool('pair_task_amend')({ task_id: 't-1', reason: 'artifact path corrected', deliverables: ['dist/final.json'] }, { agent: h.captain });
    const deliveryBoard = await readTeam(h.stateRoot, 'amend');
    check(deliveryOnly.oracle_invalidated === false && deliveryBoard.tasks[0].oracle?.sha === 'b'.repeat(64), 'deliverable-only amendments preserve the independent acceptance seal');

    const cyclic = await readTeam(h.stateRoot, 'amend');
    cyclic.tasks[1].dependencies = ['t-1'];
    cyclic.tasks[0].dependencies = [];
    await writeTeam(h.stateRoot, cyclic);
    const cycle = await fails(() => h.tool('pair_task_amend')({ task_id: 't-1', reason: 'bad graph', dependencies: ['t-2'] }, { agent: h.captain }));
    check(cycle.includes('creates a cycle'), 'task amend preserves the dependency DAG');

    const started = await readTeam(h.stateRoot, 'amend');
    started.protocol.cycles.push({ id: 'c-1', taskId: 't-1', step: 'GO', openedAt: 2 });
    await writeTeam(h.stateRoot, started);
    const late = await fails(() => h.tool('pair_task_amend')({ task_id: 't-1', reason: 'too late', description: 'changed' }, { agent: h.captain }));
    check(late.includes('already has 1 Pair Cycle') && late.includes('rewrite the standard'), 'task amend freezes once recorded work exists');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
