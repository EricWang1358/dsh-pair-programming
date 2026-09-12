/**
 * Task creation: pair_task_create — the captain (or a member proposing work)
 * adds a task to the team's dependency graph. Kept separate from flow.js
 * because creation is a planning action, not a cycle action.
 *
 * @module dsh-pair-programming/tools/task
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { withLock } from '../state/lock.js';
import { stateRootFor, workspaceOf, requireAgent, requireParticipantTeam, isCaptain } from './shared.js';
import { teamLockKey } from '../state/layout.js';
import { workspaceFingerprint } from './oracle-exec.js';
import { invalidateTaskAttempt, readTeam, writeTeam } from '../state/store.js';
import { appendPairEvent, captainSessionOf } from '../events.js';
import { validateStory } from '../protocol/story.js';
import { allocationProblems } from '../protocol/coverage.js';
import { collaborationProblems } from '../protocol/design.js';
import { taskScope } from '../runtime/parallel-tasks.js';
import { scopeConflicts } from '../runtime/worktrees.js';

const TASK_TYPES = new Set(['feature', 'spike']);
const cleanList = (values) => (Array.isArray(values) ? values.map(value => String(value).trim()).filter(Boolean) : []);

/** Validate a replacement dependency set without allowing a graph cycle. */
export function dependencyAmendmentProblems(tasks, taskId, dependencies) {
  const wanted = cleanList(dependencies);
  const byId = new Map((tasks ?? []).map(task => [task.id, task]));
  const problems = [];
  const unknown = wanted.filter(id => !byId.has(id));
  const duplicates = wanted.filter((id, index) => wanted.indexOf(id) !== index);
  if (unknown.length > 0) problems.push(`dependencies: unknown ${[...new Set(unknown)].join(', ')}`);
  if (wanted.includes(taskId)) problems.push(`dependencies: task "${taskId}" cannot depend on itself`);
  if (duplicates.length > 0) problems.push(`dependencies: duplicate ${[...new Set(duplicates)].join(', ')}`);
  const reaches = (from, seen = new Set()) => {
    if (from === taskId) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (byId.get(from)?.dependencies ?? []).some(next => reaches(next, seen));
  };
  if (wanted.some(id => reaches(id))) problems.push(`dependencies: replacement creates a cycle through task "${taskId}"`);
  return problems;
}

/**
 * Another Driver's in-flight scope is the one thing a scope extension must not
 * quietly overlap.
 *
 * Measured (B4): the workflow's most ordinary event — "implementation
 * discovered it needs a regression leg / probe directory" — had no legal
 * expression at all. pair_task_amend had no write_paths parameter (it answered
 * "needs at least one replacement field"), and a card with a cycle is
 * immutable, so the team's real choice was to move the probe out of the
 * repository or to open a second card, which the deadlock then made
 * unclaimable. Extending the scope is the third answer, and it is only safe
 * while the extension does not collide with work already in flight: reading the
 * same predicate parallel admission uses keeps ONE rule for "these two Drivers
 * would touch the same paths".
 *
 * @returns {string|undefined} a refusal reason, or undefined when it is safe.
 */
export function scopeExtensionConflict(team, task, nextScope) {
  if (!team?.parallel || (nextScope?.writes ?? []).length === 0) return undefined;
  const inFlight = (team.tasks ?? []).filter(other => other.id !== task.id
    && ['claimed', 'in_progress'].includes(other.status) && (other.scope?.writes ?? []).length > 0);
  for (const other of inFlight) {
    if (scopeConflicts(nextScope, other.scope)) {
      return `SCOPE_CONFLICT: the extended write scope overlaps ${other.id} (${other.assignee ?? 'unassigned'}), whose candidate is in flight — two Drivers writing the same paths is exactly what parallel admission serializes. Wait for its integration and completion, or extend to paths that do not overlap.`;
    }
  }
  return undefined;
}

export function registerTaskTools(ctx, config, runtime) {
  const { scheduler } = runtime;

  ctx.tools.register(defineTool({
    name: 'pair_task_create',
    description: 'Create a USER STORY task in the team\'s backlog. Capture it Agile-style — "As a [specific role], I want [goal], so that [real business value]" plus acceptance criteria — not as a bare subject. The tool enforces the machine-checkable INVEST rules: no generic role ("user"), benefit must not restate the goal, acceptance criteria are mandatory (Testable). Research work uses type="spike" (small timebox; deliverable is a decision/estimate). Obviously trivial work (typo/config-only) uses trivial=true for one lightweight cycle. Tasks can depend on other tasks: a task is only claimable once every dependency is completed. After creation the scheduler wakes idle members for ready work.',
    parameters: {
      subject: { type: 'string', required: true, description: 'One-line story card summary.' },
      role: { type: 'string', description: 'Specific real user role ("travel agent", "customer service officer") — never "user". Required unless legacy=true.' },
      intent: { type: 'string', description: 'The goal: "I want ..." — the need, NOT a locked-in UI/technical implementation. Required unless legacy=true.' },
      benefit: { type: 'string', description: 'The value: "so that ..." — revenue up / cost or risk avoided / efficiency up. Not a synonym of the intent. Required unless legacy=true.' },
      acceptance_criteria: { type: 'array', items: { type: 'string' }, description: 'Observable "Done" checks (>= 1). Required unless legacy=true.' },
      acceptance_refs: { type: 'array', items: { type: 'string' }, description: 'Goal criteria this card owns, using ids from pair_start/pair_status (for example UC-2.AC-1). Required whenever the team has an enumerated goal contract.' },
      type: { type: 'string', description: 'feature (default) | spike (research timebox; completes with a decision, not code).' },
      trivial: { type: 'boolean', description: 'True only for tasks that do not need the full pairing protocol (trivial/simple changes).' },
      description: { type: 'string', description: 'Extra context beyond the story card.' },
      deliverables: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative file or directory paths this task must actually produce (patch files, reports, generated artifacts). A directory must contain a non-empty regular file; empty trees and descendant links alone do not count. The gate refuses completion when a declared path is missing or empty — an acceptance oracle proves the behaviour is right but says nothing about whether the ordered artifact was handed over.' },
      dependencies: { type: 'array', items: { type: 'string' }, description: 'Task ids that must complete before this is claimable.' },
      assignee: { type: 'string', description: 'Optional member name this task is intended for.' },
      write_paths: { type: 'array', items: { type: 'string' }, description: 'Literal relative files or directories this task may change. Parallel admission needs all three scope arrays.' },
      read_paths: { type: 'array', items: { type: 'string' }, description: 'Literal relative files or directories this task depends on; [] explicitly means none.' },
      resources: { type: 'array', items: { type: 'string' }, description: 'Shared resource names, including interfaces, lockfiles or databases; [] explicitly means none.' },
      legacy: { type: 'boolean', description: 'Escape hatch for non-story maintenance tasks: skips INVEST validation.' },
      discovery_id: { type: 'string', description: 'Product discovery selected for this iteration. Creates an unclaimable draft until Captain triages now with pair_backlog.' },
      priority: { type: 'number', description: '1 user-outcome blocker, 2 normal (default), 3 optional. Dependencies and scope safety still outrank priority.' },
      priority_reason: { type: 'string', description: 'Evidence-backed user-value rationale; required for a non-default priority.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Task ${v.task_id} created (${v.kind})${v.assignee ? ` for ${v.assignee}` : ''}.` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const stateRoot = stateRootFor(agent, config);
      const team = await requireParticipantTeam(agent, config);
      const taskType = args.type ?? 'feature';
      const scope = taskScope(args);
      if (!TASK_TYPES.has(taskType)) {
        throw new Error(`unknown task type "${args.type}" (feature | spike)`);
      }
      if (args.priority !== undefined && ![1, 2, 3].includes(args.priority)) throw new Error('priority must be 1, 2 or 3');
      if (args.priority !== undefined && args.priority !== 2 && !String(args.priority_reason ?? '').trim()) throw new Error('non-default priority requires a user-value priority_reason');
      const story = {
        subject: args.subject, role: args.role, intent: args.intent,
        benefit: args.benefit, acceptance_criteria: args.acceptance_criteria,
      };
      const errors = [];
      if (!args.legacy) {
        const check = validateStory(story);
        errors.push(...check.errors);
      }
      if (taskType === 'spike' && !args.legacy && (args.acceptance_criteria ?? []).length === 0) {
        errors.push('a spike must declare what decision/estimate it exits with (acceptance_criteria)');
      }
      if (errors.length > 0) {
        throw new Error(`INVEST check failed:\n- ${errors.join('\n- ')}`);
      }
      const created = await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        const discovery = args.discovery_id === undefined ? undefined : fresh.product?.discoveries?.find(item => item.id === args.discovery_id);
        if (args.discovery_id !== undefined) {
          if (!isCaptain(fresh, agent)) throw new Error('only the product-managing Captain may allocate discovered work');
          if (!discovery || !['untriaged', 'deferred'].includes(discovery.status) || discovery.scope !== 'within_goal') throw new Error('discovery must be unresolved and within the current goal before drafting');
          if (fresh.tasks.some(task => task.productDiscoveryId === discovery.id)) throw new Error('discovery already has a task card');
          if (args.legacy) throw new Error('discovered requirements need a user story and observable acceptance criteria');
          if (!discovery.acceptanceCriteria.every(criterion => args.acceptance_criteria?.includes(criterion))) throw new Error('draft acceptance criteria must retain every discovered requirement');
        }
        for (const dep of args.dependencies ?? []) {
          if (!fresh.tasks.some(t => t.id === dep)) throw new Error(`unknown dependency task "${dep}"`);
        }
        if (args.assignee !== undefined && !fresh.members.some(m => m.name === args.assignee && m.status !== 'removed')) {
          throw new Error(`no active member named "${args.assignee}"`);
        }
        const coverageErrors = allocationProblems(fresh, args.acceptance_refs);
        if (coverageErrors.length > 0) throw new Error(`GOAL TRACE check failed:\n- ${coverageErrors.join('\n- ')}`);
        fresh.taskSeq += 1;
        const task = {
          id: `t-${fresh.taskSeq}`,
          subject: args.subject,
          status: 'pending',
          dependencies: args.dependencies ?? [],
          ...(Array.isArray(args.acceptance_refs) && args.acceptance_refs.length > 0
            ? { acceptanceRefs: args.acceptance_refs.map(v => String(v).trim()) }
            : {}),
          ...(Array.isArray(args.deliverables) && args.deliverables.length > 0
            ? { deliverables: args.deliverables.map(v => String(v).trim()).filter(Boolean) }
            : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.assignee !== undefined ? { assignee: args.assignee } : {}),
          type: taskType,
          trivial: args.trivial === true,
          revision: 1,
          ...(fresh.parallel ? { scope } : {}),
          ...(args.priority === undefined ? {} : { priority: args.priority, priorityReason: String(args.priority_reason ?? '').trim() }),
          ...(discovery ? { productDiscoveryId: discovery.id, ready: false, discoveryContext: { observation: discovery.observation, userValue: discovery.userValue, evidence: discovery.evidence } } : {}),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        if (!args.legacy) {
          task.story = {
            role: String(args.role).trim(),
            intent: String(args.intent).trim(),
            benefit: String(args.benefit).trim(),
            acceptance_criteria: args.acceptance_criteria.map(c => String(c).trim()),
          };
        }
        fresh.tasks.push(task);
        const designErrors = collaborationProblems(fresh);
        if (designErrors.length) throw new Error(`DESIGN_NOT_READY: ${designErrors.join("; ")}`);
        await writeTeam(stateRoot, fresh);
        appendPairEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, agent.session), 'pair/task-created', {
          teamId: fresh.id, taskId: task.id, subject: task.subject,
          dependencies: task.dependencies, assignee: task.assignee, deliverables: task.deliverables ?? [],
          acceptanceRefs: task.acceptanceRefs ?? [],
          type: taskType, trivial: task.trivial,
        });
        return { task_id: task.id, assignee: task.assignee ?? null, kind: taskType === 'spike' ? 'spike' : (task.trivial ? 'trivial story' : 'story') };
      });
      // Wake idle members so the scheduler can claim the newly-ready work.
      // Same rule as flow.js: only the captain's own action lifts a pause (#75).
      await scheduler.kickTeam(workspaceOf(agent), team.id, undefined, undefined, { background: !isCaptain(team, agent) }).catch(() => undefined);
      return created;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'pair_task_amend',
    description: 'Captain only: amend a task card before its first Pair Cycle. This is the planning correction path for stale acceptance criteria, deliverables, dependencies, story wording, description, priority (1/2/3, with the same priority_reason rule as create), or the write scope (write_paths/read_paths/resources — the normal event "implementation discovered it needs a regression leg" is recorded on the card, refused when it overlaps another Driver\'s in-flight scope, and invalidates the credentials bound to the old scope). If the task was claimed, its attempt is revoked and returned to pending. A frozen oracle is invalidated only when the acceptance contract changes; scheduling and deliverable-only corrections preserve it. Once any cycle exists the card is immutable and the change needs a new task/ruling instead.',
    parameters: {
      task_id: { type: 'string', required: true },
      reason: { type: 'string', required: true, description: 'Why the card changed; stored in the task amendment trail.' },
      subject: { type: 'string', description: 'Replacement one-line summary.' },
      role: { type: 'string', description: 'Replacement story role.' },
      intent: { type: 'string', description: 'Replacement story intent.' },
      benefit: { type: 'string', description: 'Replacement story benefit.' },
      acceptance_criteria: { type: 'array', items: { type: 'string' }, description: 'Replacement observable Done checks.' },
      acceptance_refs: { type: 'array', items: { type: 'string' }, description: 'Replacement UC-N.AC-N allocation.' },
      deliverables: { type: 'array', items: { type: 'string' }, description: 'Replacement deliverable paths; [] clears them.' },
      dependencies: { type: 'array', items: { type: 'string' }, description: 'Replacement task dependencies; [] clears them.' },
      description: { type: 'string', description: 'Replacement extra context.' },
      priority: { type: 'number', description: 'Replacement priority: 1 user-outcome blocker, 2 normal, 3 optional. Scheduling, not contract: it preserves a frozen oracle and the amendment trail names it.' },
      priority_reason: { type: 'string', description: 'Required with a non-default priority, exactly as on create: the user-value rationale.' },
      write_paths: { type: 'array', items: { type: 'string' }, description: 'Replacement write scope: the task-level envelope the proposal layer, the write guard and integration all read. Extending it is explicit and visible (recorded in the card\'s amendment trail) and refuses an overlap with another Driver\'s in-flight scope.' },
      read_paths: { type: 'array', items: { type: 'string' }, description: 'Replacement declared read scope; [] clears it.' },
      resources: { type: 'array', items: { type: 'string' }, description: 'Replacement shared resource names; [] clears them.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Task ${v.task_id} amended to revision ${v.revision}${v.oracle_invalidated ? '; oracle must be re-frozen' : ''}.` }] },
    async execute(args, exec) {
      const captain = requireAgent(exec);
      const stateRoot = stateRootFor(captain, config);
      const team = await requireParticipantTeam(captain, config);
      if (!isCaptain(team, captain)) throw new Error('only the captain can amend a task card');
      const reason = String(args.reason ?? '').trim();
      if (reason === '') throw new Error('pair_task_amend needs a reason so the contract change is auditable');
      const mutable = ['subject', 'role', 'intent', 'benefit', 'acceptance_criteria', 'acceptance_refs', 'deliverables', 'dependencies', 'description', 'priority'];
      const scopeTouched = ['write_paths', 'read_paths', 'resources'].some(key => args[key] !== undefined);
      if (!mutable.some(key => args[key] !== undefined) && !scopeTouched) throw new Error('pair_task_amend needs at least one replacement field');

      let result;
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        const task = fresh.tasks.find(item => item.id === args.task_id);
        if (task === undefined) throw new Error(`unknown task "${args.task_id}"`);
        if (['completed', 'failed', 'cancelled'].includes(task.status)) {
          throw new Error(`task "${task.id}" is ${task.status}; terminal task contracts are immutable`);
        }
        const cycles = fresh.protocol.cycles.filter(cycle => cycle.taskId === task.id);
        if (cycles.length > 0) {
          throw new Error(`task "${task.id}" already has ${cycles.length} Pair Cycle(s); changing its contract now would rewrite the standard under recorded work. Create a follow-up task or record a ruling instead.`);
        }

        const changed = [];
        const replace = (field, value) => {
          if (JSON.stringify(task[field]) === JSON.stringify(value)) return;
          task[field] = value;
          changed.push(field);
        };
        if (args.subject !== undefined) {
          const subject = String(args.subject).trim();
          if (subject === '') throw new Error('subject cannot be empty');
          replace('subject', subject);
        }
        if (args.description !== undefined) replace('description', String(args.description).trim());
        // #145: priority is how the captain orders ready work, and it could only be set at create
        // time — so correcting it meant rebuilding the card and losing its attempt, dependencies and
        // history. Same validation as create, and it is scheduling rather than contract: the frozen
        // seal survives (the oracleAffecting list below does not name it).
        if (args.priority !== undefined) {
          if (![1, 2, 3].includes(args.priority)) throw new Error('priority must be 1, 2 or 3');
          const priorityReason = String(args.priority_reason ?? '').trim();
          if (args.priority !== 2 && priorityReason === '') throw new Error('non-default priority requires a user-value priority_reason');
          replace('priority', args.priority);
          if (priorityReason !== '') replace('priorityReason', priorityReason);
        }
        if (args.acceptance_refs !== undefined) {
          const refs = cleanList(args.acceptance_refs);
          const problems = allocationProblems(fresh, refs);
          if (problems.length > 0) throw new Error(`GOAL TRACE check failed:\n- ${problems.join('\n- ')}`);
          replace('acceptanceRefs', refs);
        }
        if (args.deliverables !== undefined) replace('deliverables', cleanList(args.deliverables));
        if (args.dependencies !== undefined) {
          const dependencies = cleanList(args.dependencies);
          const problems = dependencyAmendmentProblems(fresh.tasks, task.id, dependencies);
          if (problems.length > 0) throw new Error(`DEPENDENCY check failed:\n- ${problems.join('\n- ')}`);
          replace('dependencies', dependencies);
        }
        let scopeChange;
        if (scopeTouched) {
          // A REPLACEMENT of the three scope arrays, merged with what the card
          // already declares: taskScope supplies the same validation and the
          // same `declared` admission flag that creation uses, so an amended
          // card is shaped exactly like a created one.
          const nextScope = taskScope({
            write_paths: args.write_paths === undefined ? (task.scope?.writes ?? []) : args.write_paths,
            read_paths: args.read_paths === undefined ? (task.scope?.reads ?? []) : args.read_paths,
            resources: args.resources === undefined ? (task.scope?.resources ?? []) : args.resources,
          });
          const conflict = scopeExtensionConflict(fresh, task, nextScope);
          if (conflict !== undefined) throw new Error(conflict);
          replace('scope', nextScope);
          if (changed.includes('scope')) scopeChange = { writes: nextScope.writes, reads: nextScope.reads, resources: nextScope.resources };
        }

        const storyTouched = ['role', 'intent', 'benefit', 'acceptance_criteria'].some(key => args[key] !== undefined);
        if (task.story !== undefined || storyTouched) {
          const story = {
            role: args.role === undefined ? task.story?.role : String(args.role).trim(),
            intent: args.intent === undefined ? task.story?.intent : String(args.intent).trim(),
            benefit: args.benefit === undefined ? task.story?.benefit : String(args.benefit).trim(),
            acceptance_criteria: args.acceptance_criteria === undefined
              ? (task.story?.acceptance_criteria ?? [])
              : cleanList(args.acceptance_criteria),
          };
          const check = validateStory({ subject: task.subject, ...story });
          if (!check.ok) throw new Error(`INVEST check failed:\n- ${check.errors.join('\n- ')}`);
          const discovery = fresh.product?.discoveries?.find(item => item.id === task.productDiscoveryId);
          if (discovery && !discovery.acceptanceCriteria.every(criterion => story.acceptance_criteria.includes(criterion))) throw new Error('task amendment must retain every discovered acceptance criterion');
          replace('story', story);
        }
        if (changed.length === 0) throw new Error('pair_task_amend made no semantic change after trimming and normalization');

        const designErrors = collaborationProblems(fresh);
        if (designErrors.length) throw new Error(`DESIGN_NOT_READY: ${designErrors.join("; ")}`);
        const previousAssignee = task.assignee;
        const attemptInvalidated = task.status === 'claimed' || task.status === 'in_progress';
        if (attemptInvalidated) {
          const prepared = fresh.parallel && task.workspace ? { owner: previousAssignee,
            fingerprint: await workspaceFingerprint(task.workspace, config) } : undefined;
          invalidateTaskAttempt(task, prepared ? previousAssignee : undefined);
          if (prepared) {
            // The first cycle does not exist yet. Keep the same isolated files,
            // revoke the old capability, and re-admit this owner against the
            // amended dependencies; never reset or strand the prepared slot.
            task.preparedAmendment = prepared;
            delete task.handoffId;
          }
          const member = fresh.members.find(item => item.name === previousAssignee);
          if (member !== undefined) member.status = 'idle';
        }
        const oracleAffecting = changed.some(field => ['subject', 'description', 'acceptanceRefs', 'story'].includes(field));
        const invalidatedOracleSha = oracleAffecting ? task.oracle?.sha : undefined;
        if (oracleAffecting && task.oracle !== undefined) delete task.oracle;
        delete task.gatePassId;
        task.revision = (task.revision ?? 1) + 1;
        task.updatedAt = Date.now();
        task.amendments = [
          ...(task.amendments ?? []),
          { revision: task.revision, reason, changedFields: changed, by: 'captain', at: Date.now(),
            ...(invalidatedOracleSha === undefined ? {} : { invalidatedOracleSha }),
            ...(scopeChange === undefined ? {} : { scopeWrites: scopeChange.writes }) },
        ];
        await writeTeam(stateRoot, fresh);
        appendPairEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'pair/task-updated', {
          teamId: fresh.id, taskId: task.id, action: 'amend', revision: task.revision,
          changedFields: changed, oracleInvalidated: invalidatedOracleSha !== undefined,
        });
        result = {
          task_id: task.id,
          revision: task.revision,
          changed_fields: changed,
          oracle_invalidated: invalidatedOracleSha !== undefined,
          attempt_invalidated: attemptInvalidated,
          status: task.status,
          ...(scopeChange === undefined ? {} : { scope_writes: scopeChange.writes }),
        };
      });
      await scheduler.kickTeam(workspaceOf(captain), team.id, undefined).catch(() => undefined);
      return result;
    },
  }));
}
