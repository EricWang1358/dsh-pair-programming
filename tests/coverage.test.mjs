import { normalizeUseCases, allocationProblems, goalCoverage, planningCoverageError, oracleCoverageProblems } from '../lib/protocol/coverage.js';
import { completionReadiness, makeCompletionReceipt } from '../lib/protocol/completion.js';
import { initialProtocolState } from '../lib/protocol/machine.js';
import { gateStateFingerprint } from '../lib/protocol/gate.js';

const fails = (fn) => { try { fn(); return ''; } catch (error) { return String(error?.message ?? error); } };

function fixture() {
  const useCases = normalizeUseCases([
    { actor: 'viewer', intent: 'inspect the scene', outcome: 'understand the camera', acceptance_criteria: ['film loop plays', 'four presets work'] },
    { actor: 'developer', intent: 'diagnose rendering', outcome: 'find faults quickly', acceptance_criteria: ['views 0-9 switch', '21 parameters are editable'] },
  ]);
  return {
    id: 'c1', useCases, processLessons: { at: 7 },
    tasks: [], protocol: { ...initialProtocolState(), phase: 'PLANNING' },
  };
}

export async function run(check) {
  check(fails(() => normalizeUseCases([])).includes('enumerate every'), 'A pair_start cannot freeze an empty epic contract');
  check(fails(() => normalizeUseCases([{ actor: 'viewer', intent: 'x', outcome: '', acceptance_criteria: [] }])).includes('outcome'), 'A incomplete use cases fail with named fields');
  const team = fixture();
  check(team.useCases[0].acceptanceCriteria[1].id === 'UC-1.AC-2' && team.useCases[1].acceptanceCriteria[1].text.includes('21'), 'A stable ids preserve each listed requirement independently');
  check(allocationProblems(team, ['UC-9.AC-1']).some(p => p.includes('unknown')), 'B task cards cannot invent a goal reference');
  team.tasks.push({ id: 't-1', status: 'in_progress', acceptanceRefs: ['UC-1.AC-1', 'UC-1.AC-2'], oracle: { caseRefs: ['UC-1.AC-1'] } });
  const before = goalCoverage(team);
  check(before.total === 4 && before.allocated === 2 && before.verified === 1, 'B coverage distinguishes on-card from executable, instead of a single done percent');
  check(planningCoverageError(team).includes('UC-2.AC-1') && planningCoverageError(team).includes('UC-2.AC-2'), 'B implementation is blocked while requested controls are absent from every card');
  check(oracleCoverageProblems(team.tasks[0], ['UC-1.AC-1']).some(p => p.includes('UC-1.AC-2')), 'C an oracle cannot freeze while one card criterion has no executable case');
  team.tasks.push({ id: 't-2', status: 'completed', acceptanceRefs: ['UC-2.AC-1', 'UC-2.AC-2'], gatePassId: 'g2', oracle: { caseRefs: ['UC-2.AC-1', 'UC-2.AC-2'] } });
  team.protocol.gatePasses.push({ id: 'g2', taskId: 't-2' });
  check(planningCoverageError(team) === undefined, 'C all criteria allocated freezes planning scope');
  let ready = completionReadiness(team, { greenEvidence: 'green' });
  check(!ready.ready && ready.failures.some(f => f.includes('t-1[in_progress]')) && ready.failures.some(f => f.includes('UC-1.AC-2')), 'D terminal success reports both unfinished work and missing executable coverage');
  team.tasks[0].status = 'completed'; team.tasks[0].gatePassId = 'g1'; team.tasks[0].oracle.caseRefs.push('UC-1.AC-2');
  team.protocol.gatePasses.push({ id: 'g1', taskId: 't-1' }); team.protocol.phase = 'RETRO';
  for (const pass of team.protocol.gatePasses) {
    pass.binding = { gateStateSha: gateStateFingerprint(team, pass.taskId), worktreeSha: 'final-tree' };
  }
  ready = completionReadiness(team, { greenEvidence: '473 passed', worktreeSha: 'final-tree' });
  check(ready.ready && ready.coverage.completed === 4, 'D success requires every listed criterion through a completed gated card');
  const stale = structuredClone(team);
  stale.protocol.decisions.push({ id: 'late', taskId: 't-1', rationale: 'changed after gate' });
  check(!completionReadiness(stale, { greenEvidence: '473 passed', worktreeSha: 'final-tree' }).ready, 'D successful stop rejects a task credential stale against late board changes');
  const receipt = makeCompletionReceipt(team, '473 passed', 9);
  check(receipt.id.startsWith('pair-complete:') && receipt.tasks.every(t => t.gatePassId?.startsWith('g')), 'D receipt binds the epic coverage to exact task gate credentials');
  const altered = structuredClone(team); altered.tasks[0].gatePassId = 'different';
  check(makeCompletionReceipt(altered, '473 passed', 9).id !== receipt.id, 'D changing a gate credential changes the receipt');
}
