/**
 * Who owns one checkout — judged from the BOARDS ON DISK, never from which sessions
 * happen to be loaded in this process.
 *
 * Why that distinction is the whole point (plan section J2, measured by review):
 * the availability check used to ask whether any of a team's sessions was currently
 * loaded. After a host restart none of them is, so an unrelated team started happily
 * in a checkout a live board already owned; reopening the first team's conversation
 * then auto-tracked it, the heartbeat restored its members, and two teams were
 * writing one production workspace. A loaded-session test cannot see a board that is
 * merely not in memory yet, and the board is the thing that survives a restart.
 *
 * Ownership belongs to the TEAM, not to a Driver: a dual-Driver team keeps its own
 * worktrees and slots, and this module only answers "may a team run here at all".
 *
 * @module dsh-pair-programming/state/ownership
 */
import { inspectTeams } from './store.js';

/** A board is finished with its checkout once it is archived. */
export const isTerminalPhase = team => ['DONE', 'ABORTED'].includes(team?.protocol?.phase);

/**
 * The non-terminal team that owns this checkout, or undefined when none does.
 *
 * @param {string} stateRoot - the state directory of the checkout in question.
 * @param {string} [exceptId] - the team asking, which never owns itself out.
 * @returns {Promise<{teamId:string, phase:string}|undefined>}
 */
export async function workspaceOwner(stateRoot, exceptId) {
  let scan;
  try {
    scan = await inspectTeams(stateRoot);
  } catch {
    // An unreadable state tree must never license a second team into a checkout we
    // could not inspect: the caller decides what an unknown means, and refusing is
    // the only reading that cannot lose the user's work.
    return { teamId: '(unreadable state directory)', phase: 'unknown' };
  }
  for (const team of scan.teams) {
    if (team.id === exceptId) continue;
    if (isTerminalPhase(team)) continue;
    return { teamId: team.id, phase: team.protocol?.phase ?? 'unknown' };
  }
  return undefined;
}

/**
 * The one refusal every entry point shows, so starting, resuming and waking all name
 * the occupant and the way out instead of each inventing its own sentence.
 */
export function workspaceBusyError(owner) {
  return new Error('PAIR_WORKSPACE_BUSY: team ' + owner.teamId + ' owns this checkout on disk (phase ' + owner.phase
    + '), so another team may not start here, resume into it, or wake members into it. Every board stays READABLE through pair_status(list_runs=true). '
    + 'To hand the checkout over: close that team with pair_stop from its own captain session, or adopt it explicitly with pair_start(resume_team=..., resume_from_captain=...). '
    + 'Artifact namespaces do not isolate production files, and deleting tasks or aborting a board is not a recovery.');
}
