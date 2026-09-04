/**
 * Task creation: pair_task_create — the captain (or a member proposing work)
 * adds a task to the team's dependency graph. Kept separate from flow.js
 * because creation is a planning action, not a cycle action.
 *
 * @module dsh-pair-programming/tools/task
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { withLock } from '../state/lock.js';
import { stateRootFor, workspaceOf, requireAgent, requireParticipantTeam } from './shared.js';
import { teamLockKey } from '../state/layout.js';
import { readTeam, writeTeam } from '../state/store.js';
import { appendPairEvent, captainSessionOf } from '../events.js';
import { validateStory } from '../protocol/story.js';
import { allocationProblems } from '../protocol/coverage.js';

const TASK_TYPES = new Set(['feature', 'spike']);

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
      deliverables: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths this task must actually produce (patch files, reports, generated artifacts). The gate refuses completion when a declared path is missing or empty — an acceptance oracle proves the behaviour is right but says nothing about whether the ordered artifact was handed over.' },
      dependencies: { type: 'array', items: { type: 'string' }, description: 'Task ids that must complete before this is claimable.' },
      assignee: { type: 'string', description: 'Optional member name this task is intended for.' },
      legacy: { type: 'boolean', description: 'Escape hatch for non-story maintenance tasks: skips INVEST validation.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Task ${v.task_id} created (${v.kind})${v.assignee ? ` for ${v.assignee}` : ''}.` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const stateRoot = stateRootFor(agent, config);
      const team = await requireParticipantTeam(agent, config);
      const taskType = args.type ?? 'feature';
      if (!TASK_TYPES.has(taskType)) {
        throw new Error(`unknown task type "${args.type}" (feature | spike)`);
      }
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
      await scheduler.kickTeam(workspaceOf(agent), team.id, undefined).catch(() => undefined);
      return created;
    },
  }));
}
