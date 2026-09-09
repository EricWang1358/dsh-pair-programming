import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeUseCases, planningCoverageError, oracleCoverageProblems } from '../lib/protocol/coverage.js';
import { collaborationProblems, taskDesignContext } from '../lib/protocol/design.js';
import { claimEligibility } from '../lib/runtime/parallel-tasks.js';
import { gateStateFingerprint } from '../lib/protocol/gate.js';
import { completionReadiness } from '../lib/protocol/completion.js';
import { initialProtocolState } from '../lib/protocol/machine.js';
import { isJsonValue } from '@deepseek-ai/dsh-util-values';
import { registerLifecycleTools } from '../lib/tools/lifecycle.js';
import { registerFlowTools } from '../lib/tools/flow.js';
import { registerTaskTools } from '../lib/tools/task.js';
import { createTeamDir, readTeam, writeTeam } from '../lib/state/store.js';

const design = () => ({ responsibility: 'Own submission state', approach: 'Application service coordinates execution',
  invariants: ['one terminal result per submission'], failure_behavior: 'timeout records a terminal result',
  tradeoffs: 'serial state commit costs throughput', pattern: 'Application Service', pattern_reason: 'one owner coordinates executor and result store' });
const input = () => [
  { actor: 'candidate', intent: 'submit a solution', outcome: 'receive one verdict', acceptance_criteria: ['submission recorded'], design: design(),
    interactions: [{ ...design(), target: 'UC-2', requires: ['UC-2.AC-1'], contract: 'execute(id, source) returns verdict or timeout; repeat id never duplicates terminal result',
      acceptance_criteria: ['executor timeout produces one terminal result', 'repeated callback does not create a second result'] }] },
  { actor: 'judge operator', intent: 'execute a submission', outcome: 'bound resource use', acceptance_criteria: ['execution stops at timeout'] },
];
const tasks = () => [
  { id: 't-1', status: 'pending', dependencies: [], acceptanceRefs: ['UC-2.AC-1'] },
  { id: 't-2', status: 'pending', dependencies: ['t-1'], acceptanceRefs: ['UC-1.AC-1', 'UC-1.AC-2', 'UC-1.AC-3'] },
];
const board = () => ({ id: 'design', name: 'Design', goal: 'reliable judge', mode: 'light', captainSessionId: 'cap',
  createdAt: 1, updatedAt: 1, members: [], taskSeq: 2, useCases: normalizeUseCases(input()), tasks: tasks(), protocol: initialProtocolState() });
const failure = async fn => { try { await fn(); return ''; } catch (error) { return error.message; } };

export async function run(check) {
  const team = board();
  check(team.useCases[0].acceptanceCriteria.map(c => c.id).join() === 'UC-1.AC-1,UC-1.AC-2,UC-1.AC-3', 'design preserves base ids and appends joint acceptance cases');
  check(team.useCases[0].acceptanceCriteria[1].interactionId === 'UC-1.I-1', 'joint criteria retain their collaboration origin');
  check(!collaborationProblems(team).length && planningCoverageError(team) === undefined, 'provider-first allocation admits collaboration');
  const omitted = board(); omitted.tasks[1].acceptanceRefs = ['UC-1.AC-1'];
  check(planningCoverageError(omitted)?.includes('UC-1.AC-2'), 'separately covered use cases cannot omit joint acceptance');
  check(oracleCoverageProblems(team.tasks[1], ['UC-1.AC-1']).length > 0, 'oracle must execute the joint cases too');
  const split = board(); split.tasks[1].acceptanceRefs.pop();
  check(collaborationProblems(split).some(p => p.includes('all interaction cases')), 'one collaboration cannot be partially assigned');
  const duplicate = board(); duplicate.tasks.push({ ...structuredClone(duplicate.tasks[1]), id: 't-3' });
  check(collaborationProblems(duplicate).some(p => p.includes('one accountable')), 'duplicate interaction ownership is refused');
  const missing = board(); missing.tasks[1].dependencies = [];
  check(collaborationProblems(missing).some(p => p.includes('dependency')), 'disjoint paths do not substitute for provider dependency');
  check(claimEligibility(missing, {}, missing.tasks[1])?.startsWith('DESIGN_NOT_READY'), 'restored invalid collaboration cannot be claimed');
  check(completionReadiness(missing).failures.some(p => p.includes('UC-1.I-1')), 'terminal readiness rechecks collaboration');
  const merged = board(); merged.tasks = [{ ...merged.tasks[1], dependencies: [], acceptanceRefs: ['UC-2.AC-1', ...merged.tasks[1].acceptanceRefs] }];
  check(!collaborationProblems(merged).length, 'coupled work can stay in one vertical slice');
  const transitive = board(); transitive.tasks.push({ id: 'bridge', dependencies: ['t-1'] }); transitive.tasks[1].dependencies = ['bridge'];
  check(!collaborationProblems(transitive).length, 'transitive provider dependencies are valid');
  const context = taskDesignContext(team, team.tasks[1]);
  check(context.length === 1 && context[0].interactions[0].contract.includes('timeout') && context[0].criteria.length === 3, 'handoff carries only owned decisions and observable joint cases');
  check(taskDesignContext(team, team.tasks[0])[0].interactions[0].contract.includes('timeout'), 'provider receives incoming caller contract before implementing its own slice');
  const changed = board(); changed.useCases[0].design.failureBehavior = 'discard timeout';
  check(gateStateFingerprint(team, 't-2') !== gateStateFingerprint(changed, 't-2'), 'design changes invalidate bound verification evidence');
  for (const [name, mutate] of [
    ['unresolved local question', raw => { raw[0].design.open_questions = ['who commits state?']; }],
    ['unresolved interaction question', raw => { raw[0].interactions[0].open_questions = ['retry policy?']; }],
    ['empty failure behavior', raw => { raw[0].interactions[0].failure_behavior = ''; }],
    ['pattern without rationale', raw => { delete raw[0].design.pattern_reason; }],
    ['foreign provider AC', raw => { raw[0].interactions[0].requires = ['UC-1.AC-1']; }],
    ['unknown target', raw => { raw[0].interactions[0].target = 'UC-9'; }],
    ['self target', raw => { raw[0].interactions[0].target = 'UC-1'; }],
    ['missing joint cases', raw => { raw[0].interactions[0].acceptance_criteria = []; }],
    ['missing local design', raw => { delete raw[0].design; }],
  ]) {
    const raw = input(); mutate(raw);
    check((await failure(() => normalizeUseCases(raw))).startsWith('DESIGN_NOT_READY'), `design refuses ${name}`);
  }
  const direct = input(); delete direct[0].design.pattern; delete direct[0].design.pattern_reason;
  check(normalizeUseCases(direct)[0].design.pattern === undefined, 'direct composition needs no ceremonial pattern');
  const legacy = input().map(({ design, interactions, ...old }) => old);
  check(normalizeUseCases(legacy)[0].acceptanceCriteria.length === 1, 'legacy use cases do not acquire new mandatory reviews');

  const root = await mkdtemp(join(tmpdir(), 'pair-design-'));
  try {
    const stateRoot = join(root, 'state');
    const defs = []; let kicks = 0;
    const ctx = { tools: { register: def => defs.push(def) }, logger: { warn() {}, debug() {} }, agents: { get() {} }, subagents: {} };
    registerTaskTools(ctx, { stateDir: 'state' }, { scheduler: { kickTeam: async () => { kicks++; } } });
    const agent = { id: 'cap', session: { header: { cwd: root }, append() {} } };
    const call = (name, args) => defs.find(def => def.name === name).execute(args, { agent });
    const initial = board(); initial.tasks = []; initial.taskSeq = 0;
    await createTeamDir(stateRoot, initial);
    const consumer = { subject: 'coordinate result', legacy: true, acceptance_refs: team.tasks[1].acceptanceRefs };
    check((await failure(() => call('pair_task_create', consumer))).includes('DESIGN_NOT_READY'), 'real create refuses missing collaboration provider');
    check((await readTeam(stateRoot, initial.id)).taskSeq === 0 && kicks === 0, 'rejected create has no board or scheduling side effect');
    await call('pair_task_create', { subject: 'executor', legacy: true, acceptance_refs: ['UC-2.AC-1'] });
    await call('pair_task_create', { ...consumer, dependencies: ['t-1'] });
    check((await readTeam(stateRoot, initial.id)).tasks.length === 2, 'real create admits provider then dependent consumer');
    for (const args of [
      { task_id: 't-2', dependencies: [] },
      { task_id: 't-1', acceptance_refs: ['UC-1.AC-1'] },
    ]) check((await failure(() => call('pair_task_amend', { ...args, reason: 'invalid collaboration change' }))).includes('DESIGN_NOT_READY'), 'amend cannot break either side of an existing contract');
    const runtime = { scheduler: { kickTeam: async () => {} }, selections: {} };
    registerLifecycleTools(ctx, { stateDir: 'state' }, runtime);
    registerFlowTools(ctx, { stateDir: 'state' }, runtime);
    const status = await call('pair_status', { design_task_id: 't-2' });
    check(status.summary.includes('repeated callback') && status.design_context.length === 1 && isJsonValue(status), 'QA reads a lossless task design through the native status renderer');
    check(!(await call('pair_status', {})).summary.includes('repeated callback'), 'routine status avoids repeating full design context');
    check((await failure(() => call('pair_status', { design_task_id: 'missing' }))).includes('unknown design task'), 'invalid design lookup is explicit');
    const preserved = await readTeam(stateRoot, initial.id);
    check(preserved.tasks[0].acceptanceRefs[0] === 'UC-2.AC-1' && preserved.tasks[1].dependencies[0] === 't-1' && kicks === 2, 'failed amendment preserves both cards without waking members');
    preserved.mode = 'solo'; preserved.tasks[0].status = 'completed';
    await writeTeam(stateRoot, preserved);
    const receipt = await call('pair_task_claim', { task_id: 't-2' });
    const rendered = defs.find(def => def.name === 'pair_task_claim').output.render({}, receipt);
    check(receipt.design_context.length === 1 && rendered[0].text.includes('repeated callback') && isJsonValue(receipt), 'Driver claim receipt carries the same lossless collaboration contract');
  } finally { await rm(root, { recursive: true, force: true }); }
}
