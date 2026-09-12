/** Repair checkpoint invocation errors without changing the acceptance contract. */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { withLock } from '../state/lock.js';
import { teamLockKey } from '../state/layout.js';
import { readTeam, writeTeam } from '../state/store.js';
import { commandShapeError } from '../protocol/command-shape.js';
import { resolveCycleOracle } from '../protocol/oracle.js';
import { encodeMessage } from '../protocol/messages.js';
import { driverForTask } from '../runtime/parallel-tasks.js';
import { taskWorkspace } from '../runtime/workspace-context.js';
import { digestOracleFiles } from './oracle-exec.js';
import { checkCancellation, requireLiveEvidenceTarget } from './verification-boundary.js';
import { requireAgent, requireParticipantTeam, stateRootFor, workspaceOf, isCaptain, identityOf, deliverProtocolMessage } from './shared.js';

export function registerRepairTools(ctx, config, runtime) {
  ctx.tools.register(defineTool({
    name: 'pair_repair_verify_plan',
    description: 'Navigator or Captain only: repair an erroneous intermediate checkpoint command on the latest live cycle, with evidence. Preserves the frozen acceptance oracle and all failure history/budgets, invalidates prior GREEN/report/verification, and requires fresh GREEN. Prefer a script file over nested inline shell quotes. If the candidate is already complete, pair_verify(stage="final") runs the full frozen oracle without using verify_plan; no repair or acceptance bypass is needed.',
    parameters: {
      cycle_id: { type: 'string', required: true },
      verify_plan: { type: 'string', required: true, description: 'Corrected runnable checkpoint command; never a replacement acceptance oracle.' },
      reason: { type: 'string', required: true, description: 'Why the previous command failed to measure this implementation slice.' },
      evidence: { type: 'array', items: { type: 'string' }, required: true, description: 'Observed command failure and evidence supporting this correction.' },
    },
    output: { schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: `Checkpoint command repaired for ${value.cycle_id}; step ${value.step}. Record fresh GREEN before verification; final acceptance still runs the frozen oracle.` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const team = await requireParticipantTeam(agent, config);
      const stateRoot = stateRootFor(agent, config);
      const shape = commandShapeError(args.verify_plan);
      if (shape !== undefined) throw new Error(shape);
      if (typeof args.reason !== 'string' || !args.reason.trim()) throw new Error('verify_plan repair needs a nonblank reason');
      if (!Array.isArray(args.evidence) || !args.evidence.length || args.evidence.some(e => typeof e !== 'string' || !e.trim())) {
        throw new Error('verify_plan repair needs nonblank observed evidence entries');
      }
      const command = args.verify_plan.trim();
      const result = await withLock(teamLockKey(stateRoot, team.id), async () => {
        checkCancellation(exec.signal);
        const fresh = await readTeam(stateRoot, team.id);
        const cycle = fresh?.protocol.cycles.find(c => c.id === args.cycle_id);
        if (!cycle) throw new Error('unknown cycle for verify_plan repair');
        const { task, member } = requireLiveEvidenceTarget(fresh, cycle.taskId, agent);
        if (!isCaptain(fresh, agent) && (fresh.mode === 'solo' || member?.role !== 'navigator')) {
          throw new Error('only an active Navigator or the captain can repair verify_plan; a Driver cannot weaken its own checkpoint');
        }
        if (!['claimed', 'in_progress'].includes(task.status)) throw new Error('verify_plan repair requires a live claimed or in_progress task');
        if (fresh.protocol.cycles.filter(c => c.taskId === task.id).at(-1)?.id !== cycle.id) throw new Error('only the latest task cycle can repair verify_plan');
        if (cycle.verify?.verdict === 'accept' || cycle.step === 'CLOSED') throw new Error('a completed cycle is immutable; final acceptance is never repaired');
        if (!cycle.proposal) throw new Error('cycle has no proposal to repair');
        if (String(cycle.proposal.verify_plan ?? '').trim() === command) throw new Error('verify_plan is unchanged; repair must correct the command');
        const sealed = resolveCycleOracle(cycle, task);
        if (sealed.error !== undefined) throw new Error(sealed.error);
        if (!sealed.oracle) throw new Error('verify_plan repair requires the current frozen oracle; legacy asserted acceptance cannot protect a changed checkpoint');
        const workspace = taskWorkspace(fresh, task.id, workspaceOf(agent));
        if (await digestOracleFiles(workspace, sealed.oracle.files) !== sealed.oracle.sha) throw new Error('frozen oracle digest changed; checkpoint repair cannot bypass a tampered acceptance contract');
        checkCancellation(exec.signal);
        const at = Date.now();
        cycle.verificationRepairs ??= [];
        cycle.verificationRepairs.push({ from: cycle.proposal.verify_plan ?? null, to: command,
          reason: args.reason.trim(), evidence: [...args.evidence], by: identityOf(fresh, agent), at,
          previous: structuredClone({ step: cycle.step, review: cycle.review ?? null, green: cycle.green ?? null, report: cycle.report ?? null, verify: cycle.verify ?? null }) });
        cycle.proposal.verify_plan = command;
        cycle.step = cycle.review?.verdict === 'go' || cycle.review?.auto === true ? 'GO' : 'PROPOSED';
        delete cycle.green; delete cycle.report; delete cycle.verify;
        delete task.gatePassId;
        await writeTeam(stateRoot, fresh);
        return { team: fresh, cycle_id: cycle.id, task_id: task.id, step: cycle.step, repair_count: cycle.verificationRepairs.length };
      });
      const { team: fresh, ...receipt } = result;
      const action = receipt.step === 'GO' ? 'Run the corrected command and record fresh GREEN; the frozen oracle remains the final acceptance contract.'
        : 'Obtain GO before fresh GREEN; the corrected command grants no implementation permission.';
      // The solo captain is already the caller; no Driver mailbox exists.
      const sent = fresh.mode === 'solo' ? { delivered: 'current-caller' }
        : await deliverProtocolMessage(ctx, config, agent, fresh, driverForTask(fresh, receipt.task_id), encodeMessage('INFO', {
          ...receipt, verify_plan: command, action,
        }), exec);
      // The same flag the other kick sites carry (#75): this kick exists to start a turn, not to lift
      // a captain pause, so a navigate-time repair of a member's own checkpoint cannot resume a run
      // the captain stopped. A captain repair stays a deliberate action and clears the pause.
      if (sent.delivered === 'mailbox' && !sent.recoveryKick) await runtime?.scheduler?.kickTeam?.(workspaceOf(agent), team.id, undefined, undefined, { background: !isCaptain(fresh, agent) }).catch(() => undefined);
      return { ...receipt, delivered: sent.delivered, you_owe_next: fresh.mode === 'solo' ? action : sent.you_owe_next };
    },
  }));
}
