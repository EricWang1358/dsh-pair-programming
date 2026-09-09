import assert from 'node:assert/strict';
import { reportDiscovery, triageDiscovery, rankReadyTasks, productSummary } from '../lib/protocol/product.js';

const fixture = () => ({ tasks: [{ id: 't-source', status: 'completed' }], protocol: { cycles: [] } });
const finding = (over = {}) => ({ observation: 'Empty imports hide the next step', user_value: 'Let maintainers recover without guessing', evidence: ['src/import.mjs:42 reproduces an empty result'], acceptance_criteria: ['Empty imports explain the next action'], scope: 'within_goal', ...over });
const draft = (team, discovery, over = {}) => {
  const task = { id: 't-new', status: 'pending', ready: false, productDiscoveryId: discovery.id, story: { acceptance_criteria: [...discovery.acceptanceCriteria] }, ...over };
  team.tasks.push(task);
  return task;
};
const decision = (discovery, over = {}) => ({ discovery_id: discovery.id, decision: 'now', priority: 1, rationale: 'Blocks the import recovery scenario', task_id: 't-new', ...over });

export async function run(report) {
  const check = (name, fn) => { try { fn(); report(true, name); } catch (error) { report(false, `${name}: ${error.stack}`); } };
  check('discoveries require user value, concrete evidence, acceptance checks and explicit scope before mutation', () => {
    for (const invalid of [{ observation: ' ' }, { user_value: null }, { evidence: [] }, { evidence: ['ok', ' '] }, { evidence: [42] }, { acceptance_criteria: [] }, { acceptance_criteria: [''] }, { scope: undefined }, { scope: 'guess' }, { source_task_id: 'missing' }]) {
      const team = fixture();
      assert.throws(() => reportDiscovery(team, finding(invalid), 'navigator'));
      assert.equal(team.product, undefined);
    }
    const team = fixture();
    const { discovery, reused } = reportDiscovery(team, finding({ source_task_id: 't-source' }), 'navigator');
    assert.equal(reused, false);
    assert.match(discovery.id, /^discovery-/);
    assert.equal(discovery.status, 'untriaged');
    assert.equal(discovery.observedBy, 'navigator');
    assert.equal(discovery.sourceTaskId, 't-source');
    assert.equal(discovery.userValue, finding().user_value);
    assert.deepEqual(discovery.acceptanceCriteria, finding().acceptance_criteria);
    assert.equal(typeof discovery.createdAt, 'number');
  });
  check('normalized duplicate observations reuse the original record without overwriting its evidence or actor', () => {
    const team = fixture();
    const original = reportDiscovery(team, finding({ source_task_id: 't-source' }), 'navigator').discovery;
    const repeated = reportDiscovery(team, finding({ observation: '  EMPTY  imports\n hide the NEXT step ', source_task_id: 't-source', evidence: ['different'] }), 'driver');
    assert.equal(repeated.reused, true);
    assert.equal(repeated.discovery, original);
    assert.deepEqual(original.evidence, finding().evidence);
    assert.equal(original.observedBy, 'navigator');
    assert.equal(reportDiscovery(team, finding(), 'driver').reused, false);
    assert.equal(team.product.discoveries.length, 2);
  });
  check('untriaged cap accepts duplicates and preserves settled history while freeing admission', () => {
    const team = fixture();
    const records = Array.from({ length: 20 }, (_, i) => reportDiscovery(team, finding({ observation: `finding ${i}` }), 'navigator').discovery);
    assert.throws(() => reportDiscovery(team, finding(), 'driver'), /20/);
    assert.equal(reportDiscovery(team, finding({ observation: 'Finding 0' }), 'driver').reused, true);
    triageDiscovery(team, decision(records[0], { decision: 'later' }), 'captain');
    reportDiscovery(team, finding(), 'driver');
    assert.equal(team.product.discoveries.length, 21);
    assert.equal(team.product.discoveries[0].status, 'deferred');
    assert.equal(productSummary(team).untriaged, 20);
  });
  check('only explicit now activates the linked unstarted draft with a ranked rationale', () => {
    const team = fixture();
    const discovery = reportDiscovery(team, finding(), 'navigator').discovery;
    const task = draft(team, discovery);
    triageDiscovery(team, decision(discovery, { decision: 'later', priority: 3 }), 'captain');
    assert.equal(task.ready, false);
    assert.equal(task.priority, undefined);
    const result = triageDiscovery(team, decision(discovery), 'captain');
    assert.equal(result, discovery);
    assert.equal(discovery.status, 'scheduled');
    assert.equal(discovery.taskId, task.id);
    assert.equal(discovery.decidedBy, 'captain');
    assert.equal(task.ready, true);
    assert.equal(task.priority, 1);
    assert.equal(task.priorityReason, decision(discovery).rationale);
    const before = structuredClone(team);
    assert.throws(() => triageDiscovery(team, decision(discovery, { decision: 'later' }), 'captain'), /scheduled/);
    assert.deepEqual(team, before);
  });
  check('out-of-goal findings stay recorded but cannot activate work without user decision', () => {
    const team = fixture();
    const discovery = reportDiscovery(team, finding({ scope: 'needs_user_decision' }), 'navigator').discovery;
    const task = draft(team, discovery);
    assert.throws(() => triageDiscovery(team, decision(discovery), 'captain'), /user decision/);
    assert.equal(task.ready, false);
    triageDiscovery(team, decision(discovery, { decision: 'dismiss', priority: undefined }), 'captain');
    assert.equal(discovery.status, 'dismissed');
    assert.equal(task.ready, false);
    assert.throws(() => triageDiscovery(team, decision(discovery), 'captain'));
  });
  check('scheduling refuses missing or unrelated cards, active attempts, prior cycles and missing goal trace atomically', () => {
    for (const kind of ['missing', 'unrelated', 'claimed', 'attempt', 'cycle', 'trace', 'lost-criteria', 'malformed-criteria']) {
      const team = fixture();
      const discovery = reportDiscovery(team, finding(), 'navigator').discovery;
      const task = draft(team, discovery);
      if (kind === 'missing') team.tasks.pop();
      if (kind === 'unrelated') task.productDiscoveryId = 'someone-else';
      if (kind === 'claimed') task.status = 'claimed';
      if (kind === 'attempt') task.attemptId = 'attempt-1';
      if (kind === 'cycle') team.protocol.cycles.push({ taskId: task.id });
      if (kind === 'trace') team.useCases = [{ id: 'UC-1' }];
      if (kind === 'lost-criteria') task.story.acceptance_criteria = ['A weaker requirement'];
      if (kind === 'malformed-criteria') task.story.acceptance_criteria = discovery.acceptanceCriteria.join(', ');
      const before = structuredClone(team);
      assert.throws(() => triageDiscovery(team, decision(discovery), 'captain'));
      assert.deepEqual(team, before);
    }
    const team = fixture();
    team.useCases = [{ id: 'UC-1' }];
    const discovery = reportDiscovery(team, finding(), 'navigator').discovery;
    draft(team, discovery, { acceptanceRefs: ['UC-1.AC-1'] });
    assert.equal(triageDiscovery(team, decision(discovery), 'captain').status, 'scheduled');
  });
  check('triage validates decision, priority and rationale before changing a record', () => {
    for (const invalid of [{ discovery_id: 'missing' }, { decision: 'maybe' }, { priority: 0 }, { priority: 4 }, { priority: '1' }, { priority: undefined }, { rationale: ' ' }, { task_id: undefined }]) {
      const team = fixture();
      const discovery = reportDiscovery(team, finding(), 'navigator').discovery;
      draft(team, discovery);
      const before = structuredClone(team);
      assert.throws(() => triageDiscovery(team, decision(discovery, invalid), 'captain'));
      assert.deepEqual(team, before);
    }
  });
  check('priority ranking excludes drafts and is stable without mutating the input; summaries support legacy teams', () => {
    const tasks = [{ id: 'normal' }, { id: 'urgent', priority: 1 }, { id: 'draft', priority: 1, ready: false }, { id: 'normal2', priority: 2 }, { id: 'later', priority: 3 }];
    const before = structuredClone(tasks);
    assert.deepEqual(rankReadyTasks(tasks).map(t => t.id), ['urgent', 'normal', 'normal2', 'later']);
    assert.deepEqual(tasks, before);
    assert.deepEqual(productSummary(fixture()), { untriaged: 0, deferred: 0, scheduled: 0, discoveries: [] });
  });
}
