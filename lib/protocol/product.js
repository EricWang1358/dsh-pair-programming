/** Evidence-backed product discoveries, separate from executable task cards.
 * Callers authenticate participants and persist these mutations under the team lock.
 * Capturing a finding never grants permission to change the product or starts work.
 */
import { randomUUID } from 'node:crypto';

const MAX_UNTRIAGED = 20;
const text = (value, name) => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be nonblank text`);
  return value.trim();
};
const textList = (value, name) => {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} needs at least one nonblank entry`);
  return value.map(entry => text(entry, name));
};
const normalizeObservation = value => value.trim().replace(/\s+/gu, ' ').toLowerCase();

export function reportDiscovery(team, args, actor) {
  const observation = text(args.observation, 'observation');
  const userValue = text(args.user_value, 'user_value');
  const evidence = textList(args.evidence, 'evidence');
  const acceptanceCriteria = textList(args.acceptance_criteria, 'acceptance_criteria');
  if (!['within_goal', 'needs_user_decision'].includes(args.scope)) {
    throw new Error('scope must be within_goal or needs_user_decision');
  }
  const sourceTaskId = args.source_task_id === undefined ? undefined : text(args.source_task_id, 'source_task_id');
  if (sourceTaskId !== undefined && !(team.tasks ?? []).some(task => task.id === sourceTaskId)) {
    throw new Error(`unknown source task "${sourceTaskId}"`);
  }
  const discoveries = team.product?.discoveries ?? [];
  const observationKey = normalizeObservation(observation);
  const existing = discoveries.find(item => item.sourceTaskId === sourceTaskId
    && normalizeObservation(item.observation) === observationKey);
  if (existing) return { discovery: existing, reused: true };
  if (discoveries.filter(item => item.status === 'untriaged').length >= MAX_UNTRIAGED) {
    throw new Error(`there are already ${MAX_UNTRIAGED} untriaged discoveries; triage existing findings before adding more`);
  }
  const discovery = {
    id: `discovery-${randomUUID()}`, observation, userValue, evidence, acceptanceCriteria,
    scope: args.scope, ...(sourceTaskId === undefined ? {} : { sourceTaskId }),
    observedBy: actor, createdAt: Date.now(), status: 'untriaged',
  };
  team.product ??= {};
  team.product.discoveries ??= [];
  team.product.discoveries.push(discovery);
  return { discovery, reused: false };
}

export function triageDiscovery(team, args, actor) {
  const discovery = (team.product?.discoveries ?? []).find(item => item.id === args.discovery_id);
  if (!discovery) throw new Error(`unknown discovery "${args.discovery_id}"`);
  if (!['untriaged', 'deferred'].includes(discovery.status)) {
    throw new Error(`a ${discovery.status} discovery cannot be retriaged`);
  }
  if (!['now', 'later', 'dismiss'].includes(args.decision)) throw new Error('decision must be now, later or dismiss');
  const rationale = text(args.rationale, 'rationale');
  if (args.decision !== 'dismiss' && ![1, 2, 3].includes(args.priority)) {
    throw new Error('priority must be 1, 2 or 3 for now or later');
  }
  let task;
  if (args.decision === 'now') {
    if (discovery.scope !== 'within_goal') throw new Error('this discovery needs a user decision before scheduling');
    const taskId = text(args.task_id, 'task_id');
    task = (team.tasks ?? []).find(item => item.id === taskId);
    if (!task || task.productDiscoveryId !== discovery.id) {
      throw new Error('now requires an existing task linked through productDiscoveryId to this discovery');
    }
    if (task.status !== 'pending' || task.attemptId || (team.protocol?.cycles ?? []).some(cycle => cycle.taskId === task.id)) {
      throw new Error('now requires an unstarted pending task without an attempt or any cycles');
    }
    const criteria = task.story?.acceptance_criteria;
    if (!Array.isArray(criteria) || !discovery.acceptanceCriteria.every(criterion => criteria.includes(criterion))) {
      throw new Error('the task must retain every discovered requirement in its acceptance criteria before scheduling');
    }
    if ((team.useCases ?? []).length > 0) textList(task.acceptanceRefs, 'task acceptanceRefs');
  }
  // All validation precedes either mutation, so rejected triage cannot activate a card.
  const decidedAt = Date.now();
  discovery.status = { now: 'scheduled', later: 'deferred', dismiss: 'dismissed' }[args.decision];
  discovery.rationale = rationale;
  discovery.decidedBy = actor;
  discovery.decidedAt = decidedAt;
  if (args.decision !== 'dismiss') discovery.priority = args.priority;
  if (task) {
    task.ready = true;
    task.priority = args.priority;
    task.priorityReason = rationale;
    task.updatedAt = decidedAt;
    discovery.taskId = task.id;
  }
  return discovery;
}

/** Stable scheduling preference; dependency and ownership admission remain callers' work. */
export function rankReadyTasks(tasks, eligible = () => true) {
  return (tasks ?? []).filter(task => task.ready !== false && eligible(task))
    .sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2));
}

export function productSummary(team) {
  const discoveries = team.product?.discoveries ?? [];
  const count = status => discoveries.filter(item => item.status === status).length;
  return { untriaged: count('untriaged'), deferred: count('deferred'), scheduled: count('scheduled'), discoveries };
}
