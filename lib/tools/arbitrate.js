/**
 * Arbitration & gate tools: pair_arbitrate (captain's evidence-based decision
 * log) and pair_gate_check (the hard quality gate that issues the
 * gate_pass_id required by pair_task_update).
 *
 * @module dsh-pair-programming/tools/arbitrate
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { withLock } from '../state/lock.js';
import { stateRootFor, requireAgent, requireParticipantTeam, deliverProtocolMessage, isCaptain } from './shared.js';
import { teamLockKey } from '../state/layout.js';
import { readTeam, writeTeam, recordGatePass } from '../state/store.js';
import { encodeMessage } from '../protocol/messages.js';
import { runGate } from '../protocol/gate.js';
import { namesTask, planBudgetExhausted, specFrozen } from '../protocol/machine.js';
import { randomUUID } from 'node:crypto';

export function registerArbitrateTools(ctx, config, runtime) {
  /* pair_arbitrate ------------------------------------------------------ */
  ctx.tools.register(defineTool({
    name: 'pair_arbitrate',
description: 'Captain only: resolve a conflict (Driver/Navigator disagreement, a contested risk, or an approach decision) on repository evidence. A ruling attributable to one task spends that task\'s planning budget (planningMaxArbitrations); a task that already has cycles is exempt, and a ruling naming no task spends nothing, and record the decision with rationale. Apply the 70% rule: for reversible decisions, strong (not perfect) evidence is the bar — waiting for certainty costs more than a cheap correction. Notifies the whole team.',
    parameters: {
      conflict_ref: { type: 'string', required: true, description: 'What is being decided (cycle id, risk id, or "plan").' },
      decision: { type: 'string', required: true, description: 'The chosen path.' },
      evidence: { type: 'array', items: { type: 'string' }, required: true, description: 'Repository evidence backing the choice.' },
      rationale: { type: 'string', required: true, description: 'Why this path; what is salvageable from the rejected option.' },
      task_id: { type: 'string', description: 'The task this decision belongs to, if any.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Decision ${v.decision_id} recorded for ${v.conflict_ref}.` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const stateRoot = stateRootFor(agent, config);
      const team = await requireParticipantTeam(agent, config);
      if (!isCaptain(team, agent)) throw new Error('only the captain can arbitrate');
      const decisionId = `d-${randomUUID().slice(0, 8)}`;
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        const planned = fresh.tasks.find(t => t.status !== 'cancelled' && (args.task_id === t.id || namesTask(args.conflict_ref, t.id)));
        if (planned !== undefined && specFrozen(fresh.protocol, planned.id) === false) {
          const budget = planBudgetExhausted(fresh.protocol, planned.id, config.planningMaxArbitrations ?? 2);
          if (budget.exhausted) throw new Error(budget.refusal);
        }
        fresh.protocol.decisions.push({
          id: decisionId, conflictRef: args.conflict_ref, decision: args.decision,
          evidence: args.evidence, rationale: args.rationale, taskId: args.task_id, at: Date.now(),
        });
        await writeTeam(stateRoot, fresh);
      });
      const body = encodeMessage('ARBITRATE', {
        conflict_ref: args.conflict_ref, decision: args.decision,
        evidence: args.evidence, rationale: args.rationale,
      });
      for (const member of team.members.filter(m => m.status !== 'removed')) {
        await deliverProtocolMessage(ctx, config, agent, team, member.name, body, exec);
      }
      return { decision_id: decisionId, conflict_ref: args.conflict_ref };
    },
  }));

  /* pair_gate_check ----------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_gate_check',
    description: 'Run the completion quality gate for one task: every cycle ACCEPTed, no open P0/P1 risks, verification evidence present, all arbitrations documented. On pass, issues the gate_pass_id that pair_task_update(status=completed) requires.',
    parameters: { task_id: { type: 'string', required: true, description: 'The task to gate-check.' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v.pass ? `Gate PASS for ${v.task_id} (gate_pass_id ${v.gate_pass_id}).` : `Gate FAIL for ${v.task_id}:\n- ${v.failures.join('\n- ')}` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const stateRoot = stateRootFor(agent, config);
      const team = await requireParticipantTeam(agent, config);
      return withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        if (!fresh.tasks.some(t => t.id === args.task_id)) throw new Error(`unknown task "${args.task_id}"`);
        const outcome = runGate(fresh, args.task_id, {
          tddMode: fresh.tddMode ?? config.tddMode,
          dod: config.dod,
        });
        if (!outcome.pass) {
          fresh.protocol.stats.gateFails = (fresh.protocol.stats.gateFails ?? 0) + 1;
          await writeTeam(stateRoot, fresh);
          return { task_id: args.task_id, pass: false, failures: outcome.failures, checklist: outcome.checklist };
        }
        const pass = recordGatePass(fresh, args.task_id, outcome.checklist);
        await writeTeam(stateRoot, fresh);
        return { task_id: args.task_id, pass: true, gate_pass_id: pass.id, checklist: outcome.checklist };
      });
    },
  }));
}
