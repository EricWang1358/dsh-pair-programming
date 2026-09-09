/** Evidence-backed discovery is separate from the committed iteration. */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { withLock } from '../state/lock.js';
import { teamLockKey } from '../state/layout.js';
import { readTeam, writeTeam } from '../state/store.js';
import { reportDiscovery, triageDiscovery } from '../protocol/product.js';
import { encodeMessage } from '../protocol/messages.js';
import { requireAgent, requireParticipantTeam, stateRootFor, workspaceOf, isCaptain, deliverProtocolMessage } from './shared.js';

export function registerBacklogTools(ctx, config, runtime) {
  ctx.tools.register(defineTool({
    name: 'pair_backlog',
    description: 'Discover a requirement from observed user value and evidence, or Captain-only triage it. Discovery never silently expands the implementation scope. Triage now requires a linked unstarted draft task; later/dismiss stays in the product backlog. Priority 1=blocks user outcome, 2=valuable next increment, 3=optional improvement. Correctness/security blockers still use pair_risk.',
    parameters: {
      action: { type: 'string', required: true, description: 'discover | triage' },
      observation: { type: 'string' }, user_value: { type: 'string' },
      evidence: { type: 'array', items: { type: 'string' } },
      acceptance_criteria: { type: 'array', items: { type: 'string' } },
      source_task_id: { type: 'string', description: 'Existing task id, e.g. t-1. Omit before any source card exists; UC-* identifies a goal criterion, not a task.' },
      scope: { type: 'string', description: 'within_goal | needs_user_decision; the latter cannot enter this iteration automatically' },
      discovery_id: { type: 'string' },
      decision: { type: 'string', description: 'now | later | dismiss. For now first create a draft card using discovery_id on pair_task_create.' },
      priority: { type: 'number' }, rationale: { type: 'string' }, task_id: { type: 'string' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => [{ type: 'text', text: `Discovery ${value.discovery.id}: ${value.discovery.status}${value.reused ? ' (existing)' : ''}. ${value.discovery.taskId ? `Task ${value.discovery.taskId} is ready.` : 'No implementation task was activated.'}` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const team = await requireParticipantTeam(agent, config);
      const stateRoot = stateRootFor(agent, config);
      if (!['discover', 'triage'].includes(args.action)) throw new Error('action must be discover or triage');
      const result = await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (!fresh || ['DONE', 'ABORTED'].includes(fresh.protocol.phase)) throw new Error('product backlog requires an active team');
        if (!isCaptain(fresh, agent) && !fresh.members.some(member => member.id === agent.id && member.status !== 'removed')) throw new Error('only an active participant may report a discovery');
        if (args.action === 'triage' && !isCaptain(fresh, agent)) throw new Error('only the Captain acting as product manager may triage');
        // A draft already allocated to this iteration must be scheduled. Defer
        // the discovery BEFORE creating its card, so no stranded pending card
        // silently becomes exempt from the existing completion contract.
        if (args.action === 'triage' && args.decision !== 'now' && fresh.tasks.some(task => task.productDiscoveryId === args.discovery_id)) throw new Error('this discovery already has an iteration draft; finish its scheduling instead of hiding an allocated task in the backlog');
        const output = args.action === 'discover'
          ? reportDiscovery(fresh, args, agent.id)
          : { discovery: triageDiscovery(fresh, args, agent.id), reused: false };
        if (!output.reused) await writeTeam(stateRoot, fresh);
        return output;
      });
      if (args.action === 'discover' && !result.reused && !isCaptain(team, agent)) {
        await deliverProtocolMessage(ctx, config, agent, team, 'captain', encodeMessage('INFO', {
          discovery_id: result.discovery.id, observation: result.discovery.observation,
          next: 'Triage user value and evidence with pair_backlog. Keep speculative or out-of-scope work in the backlog; do not redirect the active Driver.',
        }), exec);
      }
      if (args.action === 'triage' && args.decision === 'now') await runtime.scheduler?.kickTeam?.(workspaceOf(agent), team.id).catch(() => undefined);
      return result;
    },
  }));
}
