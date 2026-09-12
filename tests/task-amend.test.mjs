/** Planning-card amendments: correct the contract without spending arbitration. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTaskTools } from '../lib/tools/task.js';
import { createTeamDir, readTeam, writeTeam } from '../lib/state/store.js';
import { initialProtocolState } from '../lib/protocol/machine.js';
import { gateStateFingerprint } from '../lib/protocol/gate.js';
import { allowedWriteSet, withinScope } from '../lib/protocol/scope.js';

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

    /* ---- #145: priority could only be set at create time -------------------- */
    // Measured on SG-career: cancelling a card left the frontier on t-4 instead of t-2 because
    // same-priority cards are ordered by id, and the captain's ordering judgement had nowhere to
    // land — pair_task_amend had no priority field at all.
    const priorityAmend = await h.tool('pair_task_amend')({ task_id: 't-1', reason: 'this card blocks a user outcome', priority: 1, priority_reason: 'the release cannot ship without it' }, { agent: h.captain });
    const priorityBoard = await readTeam(h.stateRoot, 'amend');
    check(priorityBoard.tasks[0].priority === 1 && priorityBoard.tasks[0].priorityReason.includes('cannot ship'),
      '#145 an amendment can raise a card priority, and the reason is recorded on the card');
    check(priorityAmend.oracle_invalidated === false && priorityBoard.tasks[0].oracle?.sha === 'b'.repeat(64),
      '#145 and priority is scheduling, not contract: the independent acceptance seal survives');
    check(priorityBoard.tasks[0].amendments.at(-1).changedFields.includes('priority'),
      '#145 while the amendment trail names the field it changed');
    check((await fails(() => h.tool('pair_task_amend')({ task_id: 't-1', reason: 'bad value', priority: 4, priority_reason: 'x' }, { agent: h.captain }))).includes('1, 2 or 3'),
      '#145 a priority outside 1..3 is refused, exactly as on create');
    check((await fails(() => h.tool('pair_task_amend')({ task_id: 't-1', reason: 'why', priority: 1 }, { agent: h.captain }))).includes('priority_reason'),
      '#145 a non-default priority without a user-value reason is refused');
    check((await fails(() => h.tool('pair_task_amend')({ task_id: 't-1', reason: 'reason only', priority_reason: 'because' }, { agent: h.captain }))).includes('at least one replacement field'),
      '#145 and a reason with nothing to re-prioritise is not a change');

    const cyclic = await readTeam(h.stateRoot, 'amend');
    cyclic.tasks[1].dependencies = ['t-1'];
    cyclic.tasks[0].dependencies = [];
    await writeTeam(h.stateRoot, cyclic);
    const cycle = await fails(() => h.tool('pair_task_amend')({ task_id: 't-1', reason: 'bad graph', dependencies: ['t-2'] }, { agent: h.captain }));
    check(cycle.includes('creates a cycle'), 'task amend preserves the dependency DAG');

    /* ---- scope extension (B4) ------------------------------------------- */
    // Measured: pair_task_amend had no write_paths parameter at all, so the
    // NORMAL event "implementation discovered it needs a regression leg" could
    // only be worked around by moving files out of the repository, or by
    // opening a second task — which was unclaimable in the deadlock it caused.
    const scoping = await readTeam(h.stateRoot, 'amend');
    scoping.parallel = { slots: {}, stateRelative: '.pair-programming' };
    scoping.tasks[0].scope = { writes: ['src/a.mjs'], reads: [], resources: [], declared: true };
    scoping.tasks[0].gatePassId = 'pass-old';
    scoping.protocol.gatePasses = [{ id: 'pass-old', taskId: 't-1', binding: {} }];
    await writeTeam(h.stateRoot, scoping);
    const fingerprintBefore = gateStateFingerprint(await readTeam(h.stateRoot, 'amend'), 't-1');

    const attempt = (fn) => fn().then((value) => ({ value }), (error) => ({ error: String(error && error.message ? error.message : error) }));
    const extended = await attempt(() => h.tool('pair_task_amend')({
      task_id: 't-1', reason: 'the regression leg needs its own directory', write_paths: ['src/a.mjs', 'scratch/regression'],
    }, { agent: h.captain }));
    const extendedBoard = await readTeam(h.stateRoot, 'amend');
    const extendedTask = extendedBoard.tasks[0];
    check(extended.value && extended.value.changed_fields.includes('scope') && extended.value.scope_writes.includes('scratch/regression'), 'write_paths can be extended before the first cycle, and the tool reports the resulting scope' + (extended.error ? ': ' + extended.error : ''));
    check(extendedTask.scope.writes.length === 2 && extendedTask.scope.declared === true, 'the extension lands on the card as a declared write scope');
    const record = extendedTask.amendments.at(-1);
    check(record.changedFields.includes('scope') && record.scopeWrites.includes('scratch/regression') && record.reason.includes('regression leg'), 'the extension is explicit and visible in the audit trail: reason + what changed + who reported it');
    check(gateStateFingerprint(extendedBoard, 't-1') !== fingerprintBefore, 'and it moves the task gate fingerprint, which is what makes a credential taken against the old scope stale');
    check(extendedTask.gatePassId === undefined, 'the credential the card was holding is dropped with it');
    check(withinScope(allowedWriteSet(extendedTask, extendedBoard.protocol.cycles).allowed, 'scratch/regression/new-leg.mjs'), 'and the declared directory now admits a new file inside it without a second declaration');
    const noop = await fails(() => h.tool('pair_task_amend')({ task_id: 't-1', reason: 'second thoughts', write_paths: ['src/a.mjs', 'scratch/regression'] }, { agent: h.captain }));
    check(noop.includes('no semantic change'), 'a scope amendment that changes nothing is still refused as audit noise');

    const contested = await readTeam(h.stateRoot, 'amend');
    contested.tasks[1].status = 'in_progress';
    contested.tasks[1].assignee = 'driver';
    contested.tasks[1].scope = { writes: ['src/b.mjs'], reads: [], resources: [], declared: true };
    await writeTeam(h.stateRoot, contested);
    const overlap = await fails(() => h.tool('pair_task_amend')({ task_id: 't-1', reason: 'widen to the whole source tree', write_paths: ['src'] }, { agent: h.captain }));
    check(overlap.includes('SCOPE_CONFLICT') && overlap.includes('t-2'), 'an extension that overlaps another Driver\'s in-flight scope is refused before it can be written, and names the task it collides with');
    const disjoint = await attempt(() => h.tool('pair_task_amend')({ task_id: 't-1', reason: 'a second, non-overlapping leg directory', write_paths: ['src/a.mjs', 'scratch/regression', 'scratch/legs'] }, { agent: h.captain }));
    check(disjoint.value && disjoint.value.scope_writes.includes('scratch/legs'), 'while a non-overlapping extension goes through' + (disjoint.error ? ': ' + disjoint.error : ''));

    const started = await readTeam(h.stateRoot, 'amend');
    started.protocol.cycles.push({ id: 'c-1', taskId: 't-1', step: 'GO', openedAt: 2 });
    await writeTeam(h.stateRoot, started);
    const late = await fails(() => h.tool('pair_task_amend')({ task_id: 't-1', reason: 'too late', description: 'changed' }, { agent: h.captain }));
    check(late.includes('already has 1 Pair Cycle') && late.includes('rewrite the standard'), 'task amend freezes once recorded work exists');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
