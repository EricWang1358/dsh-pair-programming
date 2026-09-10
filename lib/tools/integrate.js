/** Captain-owned integration: a reviewed candidate is not a completed change. */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { withLock } from '../state/lock.js';
import { teamLockKey } from '../state/layout.js';
import { readTeam, writeTeam, latestGatePass } from '../state/store.js';
import { requireAgent, requireParticipantTeam, stateRootFor, isCaptain, deliverProtocolMessage } from './shared.js';
import { captureEvidenceBoundary, assertEvidenceBoundary, requireProductRun } from './verification-boundary.js';
import { gateStateFingerprint } from '../protocol/gate.js';
import { allowedWriteSet } from '../protocol/scope.js';
import { snapshotCandidate, integrateCandidate } from '../runtime/worktrees.js';
import { digestOracleFiles, runOracleCommand } from './oracle-exec.js';
import { runDodCommand } from './gate-exec.js';
import { encodeMessage } from '../protocol/messages.js';

export function registerIntegrationTools(ctx, config, runtime) {
  ctx.tools.register(defineTool({
    name: 'pair_integrate',
    description: 'Captain only, dual Driver teams: integrate one reviewed and gated candidate. Merges in a disposable Git worktree, replays its oracle and every previously integrated oracle plus the whole-suite command, then advances the canonical branch. A conflict, stale candidate or failed check leaves the canonical branch unchanged. Drivers complete only after this receipt exists.',
    parameters: { task_id: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: true },
      render: (_a, value) => [{ type: 'text', text: 'Integrated ' + value.task_id + ' at ' + value.head + '; the owner may now complete the task.' }] },
    async execute(args, exec) {
      const captain = requireAgent(exec);
      const stateRoot = stateRootFor(captain, config);
      const team = await requireParticipantTeam(captain, config);
      if (!isCaptain(team, captain)) throw new Error('only the captain can integrate a candidate');
      if (!team.parallel) throw new Error('pair_integrate is only needed for dual Driver teams');
      // This lock serializes the board receipt as well as the Git transaction.
      // It is deliberately not the team lock: the other Driver may keep working.
      const receipt = await withLock('pair-integrate-tool:' + stateRoot + ':' + team.id, async () => {
        const fresh = await readTeam(stateRoot, team.id);
        const task = fresh?.tasks.find(t => t.id === args.task_id);
        if (!task || !['claimed', 'in_progress'].includes(task.status)) throw new Error('integration needs a live task attempt');
        const boundary = await captureEvidenceBoundary(fresh, task.id, captain, config, exec.signal);
        const pass = latestGatePass(fresh, task.id);
        const review = fresh.protocol.cycles.filter(c => c.taskId === task.id).at(-1)?.verify;
        if (!pass || pass.id !== task.gatePassId || pass.binding?.worktreeSha !== boundary.worktreeSha
          || pass.binding?.gateStateSha !== gateStateFingerprint(fresh, task.id)
          || pass.binding?.taskAttempt?.attemptId !== task.attemptId
          || pass.binding?.taskAttempt?.assignee !== task.assignee
          || review?.verdict !== 'accept' || review.binding?.worktreeSha !== boundary.worktreeSha
          || review.binding?.attemptId !== task.attemptId) {
          throw new Error('INTEGRATION_STALE: obtain a final review and gate for this exact candidate and attempt');
        }
        const slot = fresh.parallel.slots[task.assignee];
        const prior = fresh.parallel.pending?.[task.id];
        let candidate = prior?.worktreeSha === boundary.worktreeSha && prior?.gatePassId === pass.id
          && prior?.attemptId === task.attemptId ? prior : undefined;
        if (!candidate) {
          // ONE allowed write set (protocol/scope.js). This used to be a
          // second rule — `scope.writes.length ? scope.writes : every proposal
          // file` — so a card that declared write_paths without
          // read_paths/resources was judged by its envelope ONLY here, and a
          // probe the write guard had admitted was refused at merge time with
          // "Candidate escapes declared write scope". The team's workaround was
          // to move its probes out of the repository.
          const { allowed } = allowedWriteSet(task, fresh.protocol.cycles);
          const snapshot = await snapshotCandidate(slot, allowed);
          await assertEvidenceBoundary(boundary, await readTeam(stateRoot, team.id), captain, config, exec.signal);
          candidate = { ...snapshot, taskId: task.id, attemptId: task.attemptId,
            worktreeSha: boundary.worktreeSha, gatePassId: pass.id };
          await withLock(teamLockKey(stateRoot, team.id), async () => {
            const current = await readTeam(stateRoot, team.id);
            await assertEvidenceBoundary(boundary, current, captain, config, exec.signal);
            current.parallel.pending ??= {};
            current.parallel.pending[task.id] = candidate;
            await writeTeam(stateRoot, current);
          });
        }
        const checks = [];
        const promoted = await integrateCandidate(fresh.parallel, candidate, {
          signal: exec.signal,
          verify: async workspace => {
            const current = await readTeam(stateRoot, team.id);
            await assertEvidenceBoundary(boundary, current, captain, config, exec.signal);
            for (const item of current.tasks.filter(t => t.id === task.id || current.parallel.integrations?.[t.id])) {
              if (!item.oracle) continue;
              const sha = await digestOracleFiles(workspace, item.oracle.files);
              if (sha !== item.oracle.sha) throw new Error('INTEGRATION_ORACLE_CHANGED: ' + item.id);
              const run = await runOracleCommand(workspace, item.oracle.cmd, { signal: exec.signal, instrumentExitCodes: item.oracle.instrumentExitCodes });
              requireProductRun(run, exec.signal);
              if (run.exit !== 0) throw new Error('INTEGRATION_ORACLE_FAILED: ' + item.id + '\n' + run.outputTail);
              if (await digestOracleFiles(workspace, item.oracle.files) !== sha) throw new Error('INTEGRATION_ORACLE_CHANGED: ' + item.id);
              checks.push({ taskId: item.id, command: item.oracle.cmd, oracleSha: sha, exit: run.exit, outputSha: run.outputSha });
            }
            const command = current.parallel.verificationCommand;
            if (!command) throw new Error('dual Driver integration needs a whole-suite command');
            const run = await runDodCommand({ ...config, dodCommand: command }, workspace, undefined, undefined, { signal: exec.signal });
            requireProductRun(run, exec.signal);
            if (run.skipped || run.exit !== 0) throw new Error('INTEGRATION_REGRESSION_FAILED: ' + (run.outputTail ?? run.reason));
            checks.push({ command, exit: run.exit });
            await assertEvidenceBoundary(boundary, await readTeam(stateRoot, team.id), captain, config, exec.signal);
          },
        });
        return withLock(teamLockKey(stateRoot, team.id), async () => {
          const current = await readTeam(stateRoot, team.id);
          await assertEvidenceBoundary(boundary, current, captain, config, exec.signal);
          const record = { candidate, ...promoted, checks, at: Date.now() };
          current.parallel.integrations ??= {};
          current.parallel.integrations[task.id] = record;
          delete current.parallel.pending[task.id];
          await writeTeam(stateRoot, current);
          return { task_id: task.id, assignee: task.assignee, ...record };
        });
      });
      await deliverProtocolMessage(ctx, config, captain, await readTeam(stateRoot, team.id), receipt.assignee,
        encodeMessage('INFO', { task_id: receipt.task_id, integrated_head: receipt.head,
          note: 'Your reviewed candidate has passed integration. Complete this task using its current attempt_id and gate_pass_id. Do not edit this candidate further.' }), exec);
      await runtime.scheduler?.kickTeam?.(team.parallel.workspace, team.id).catch(() => undefined);
      return receipt;
    },
  }));
}