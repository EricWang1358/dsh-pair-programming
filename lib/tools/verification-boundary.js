/** Bind asynchronous evidence to a live actor, task attempt and candidate. */
import { gateStateFingerprint } from '../protocol/gate.js';
import { isDispatchClosed } from '../protocol/machine.js';
import { notRunnableEvidence } from '../protocol/command-shape.js';
import { workspaceFingerprint } from './oracle-exec.js';

export function checkCancellation(signal) {
  if (signal?.aborted) throw new Error('VERIFICATION_CANCELLED: the caller cancelled this evidence run');
}

export function requireLiveEvidenceTarget(team, taskId, agent) {
  if (!team || isDispatchClosed(team.protocol.phase)) throw new Error('VERIFICATION_STALE: team is closed or no longer exists');
  const task = team.tasks.find(t => t.id === taskId);
  if (!task || ['completed', 'failed', 'cancelled'].includes(task.status)) throw new Error('VERIFICATION_STALE: task is terminal or no longer exists');
  const member = team.members.find(m => m.id === agent.id && m.status !== 'removed');
  if (!member && team.captainSessionId !== agent.id) throw new Error('VERIFICATION_STALE: the actor no longer holds an active seat');
  return { task, member };
}

function semanticStamp(team, taskId, agent) {
  const { task, member } = requireLiveEvidenceTarget(team, taskId, agent);
  return JSON.stringify({
    board: gateStateFingerprint(team, taskId),
    ownership: [task.assignee, task.attemptId, task.status, task.handoffId],
    phase: team.protocol.phase, mode: team.mode, captain: team.captainSessionId,
    actor: [agent.id, member?.name, member?.role, member?.joinedAt, member?.retiredAt],
  });
}

export async function captureEvidenceBoundary(team, taskId, agent, config, signal) {
  checkCancellation(signal);
  const semantic = semanticStamp(team, taskId, agent);
  const workspace = agent.session.header.cwd ?? process.cwd();
  const worktreeSha = await workspaceFingerprint(workspace, { stateDir: config.stateDir });
  checkCancellation(signal);
  return { semantic, worktreeSha, workspace, taskId };
}

/** Call after commands and again inside the commit lock. Detects NET drift,
 * not immutable isolation: transient ABA edits and environment inputs remain outside this stamp. */
export async function assertEvidenceBoundary(boundary, team, agent, config, signal) {
  checkCancellation(signal);
  if (semanticStamp(team, boundary.taskId, agent) !== boundary.semantic) {
    throw new Error('VERIFICATION_STALE: task attempt, cycle/report, oracle, board or actor changed during verification; rerun against the current candidate');
  }
  if (await workspaceFingerprint(boundary.workspace, { stateDir: config.stateDir }) !== boundary.worktreeSha) {
    throw new Error('VERIFICATION_STALE: candidate worktree or oracle changed during verification; this run cannot certify the changed tree');
  }
  checkCancellation(signal);
}

export function requireProductRun(run, signal) {
  checkCancellation(signal);
  const reason = typeof run.exit !== 'number' ? `command did not complete normally (${String(run.exit)})` : notRunnableEvidence(run);
  if (reason !== undefined) throw new Error(`VERIFICATION_INFRASTRUCTURE: ${reason}; no product verdict was recorded`);
}
