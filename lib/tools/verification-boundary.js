/** Bind asynchronous evidence to a live actor, task attempt and candidate. */
import { gateStateFingerprint } from '../protocol/gate.js';
import { isDispatchClosed } from '../protocol/machine.js';
import { notRunnableEvidence } from '../protocol/command-shape.js';
import { workspaceFingerprint } from './oracle-exec.js';
import { taskWorkspace } from '../runtime/workspace-context.js';

export function checkCancellation(signal) {
  if (signal?.aborted) throw new Error('VERIFICATION_CANCELLED: the caller cancelled this evidence run');
}

export function requireLiveEvidenceTarget(team, taskId, agent, { closure = false } = {}) {
  // isDispatchClosed answers "may a seat still be woken", and RETRO is inside
  // it because no new work is handed out there. Closure evidence is a
  // different question: pair_stop requires RETRO first and then demands a
  // current credential, so a gate that refuses in RETRO refuses in the only
  // phase where a successful stop can happen. Terminal boards stay closed.
  const phaseClosed = closure ? ['DONE', 'ABORTED'].includes(team?.protocol?.phase) : isDispatchClosed(team?.protocol?.phase);
  if (!team || phaseClosed) throw new Error('VERIFICATION_STALE: team is closed or no longer exists');
  const task = team.tasks.find(t => t.id === taskId);
  // The gate is the tool that CERTIFIES completion, and a completed task is
  // exactly what needs a fresh credential once a later task moves the tree:
  // pair_stop refuses a stale binding and prescribes re-running the gate, so
  // refusing it here would make that instruction impossible to obey and leave
  // every multi-task board permanently unclosable. Abandoned work stays out.
  const terminal = closure ? ['failed', 'cancelled'] : ['completed', 'failed', 'cancelled'];
  if (!task || terminal.includes(task.status)) throw new Error('VERIFICATION_STALE: task is terminal or no longer exists');
  const member = team.members.find(m => m.id === agent.id && m.status !== 'removed');
  if (!member && team.captainSessionId !== agent.id) throw new Error('VERIFICATION_STALE: the actor no longer holds an active seat');
  return { task, member };
}

function semanticStamp(team, taskId, agent, opts) {
  const { task, member } = requireLiveEvidenceTarget(team, taskId, agent, opts);
  return JSON.stringify({
    board: gateStateFingerprint(team, taskId),
    ownership: [task.assignee, task.attemptId, task.status, task.handoffId],
    phase: team.parallel && !isDispatchClosed(team.protocol.phase) ? 'ACTIVE' : team.protocol.phase, mode: team.mode, captain: team.captainSessionId,
    actor: [agent.id, member?.name, member?.role, member?.joinedAt, member?.retiredAt],
  });
}
 

export async function captureEvidenceBoundary(team, taskId, agent, config, signal, { closure = false } = {}) {
  checkCancellation(signal);
  const semantic = semanticStamp(team, taskId, agent, { closure });
  const workspace = taskWorkspace(team, taskId, agent.session.header.cwd ?? process.cwd(), { closure });
  const worktreeSha = await workspaceFingerprint(workspace, { stateDir: config.stateDir });
  checkCancellation(signal);
  // The allowance travels with the boundary: every later assertion re-derives
  // the same stamp, so a caller cannot widen it after the fact.
  return { semantic, worktreeSha, workspace, taskId, closure };
}

/** Call after commands and again inside the commit lock. Detects NET drift,
 * not immutable isolation: transient ABA edits and environment inputs remain outside this stamp. */
export async function assertEvidenceBoundary(boundary, team, agent, config, signal) {
  checkCancellation(signal);
  if (taskWorkspace(team, boundary.taskId, agent.session.header.cwd ?? process.cwd(), { closure: boundary.closure }) !== boundary.workspace) {
    throw new Error('VERIFICATION_STALE: task workspace identity changed during verification');
  }
  if (semanticStamp(team, boundary.taskId, agent, { closure: boundary.closure === true }) !== boundary.semantic) {
    throw new Error('VERIFICATION_STALE: task attempt, cycle/report, oracle, board or actor changed during verification; rerun against the current candidate');
  }
  if (await workspaceFingerprint(boundary.workspace, { stateDir: config.stateDir }) !== boundary.worktreeSha) {
    throw new Error('VERIFICATION_STALE: candidate worktree or oracle changed during verification; this run cannot certify the changed tree');
  }
  checkCancellation(signal);
}

export function requireProductRun(run, signal) {
  checkCancellation(signal);
  const reason = typeof run.exit !== 'number' ? `command did not complete normally (${String(run.exit)})`
    : run.exit === 0 ? undefined : notRunnableEvidence(run);
  if (reason !== undefined) throw new Error(`VERIFICATION_INFRASTRUCTURE: ${reason}; no product verdict was recorded`);
}
