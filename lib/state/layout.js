/**
 * `.pair-programming/` on-disk layout helpers.
 *
 * Layout:
 *   <workspace>/<stateDir>/<teamId>/team.json      — durable team+protocol record
 *   <workspace>/<stateDir>/<teamId>/inbox/<key>.jsonl — one JSONL mailbox per agent
 *   <workspace>/<stateDir>/<teamId>/decisions.md   — arbitration decision log
 *   <workspace>/<stateDir>/<teamId>/retro.md       — retrospective report
 *   <workspace>/<stateDir>/cache/<sha256>.json     — L2 evidence cache entries
 *   <workspace>/<stateDir>/retired-members.json    — deny-list of retired member ids
 *
 * @module dsh-pair-programming/state/layout
 */
import { join } from 'node:path';

/** Resolve the absolute state root for one workspace. */
export function stateRootOf(workspace, config) {
  return join(workspace, config.stateDir);
}

/** Resolve one team's directory. */
export function teamDirOf(stateRoot, teamId) {
  return join(stateRoot, teamId);
}

/** Resolve a team's durable record file. */
export function teamFileOf(stateRoot, teamId) {
  return join(stateRoot, teamId, 'team.json');
}

/** Resolve a team's inbox directory. */
export function inboxDirOf(stateRoot, teamId) {
  return join(stateRoot, teamId, 'inbox');
}

/** Resolve the L2 evidence cache directory. */
export function cacheDirOf(stateRoot) {
  return join(stateRoot, 'cache');
}

/** Resolve the retired-member deny-list file. */
export function retiredMembersFileOf(stateRoot) {
  return join(stateRoot, 'retired-members.json');
}

/** Resolve the cross-session process-lessons file (retro keep/try carry-over). */
export function lessonsFileOf(stateRoot) {
  return join(stateRoot, 'lessons.json');
}

/** Process-local lock key scoped by state root and team id. */
export function teamLockKey(stateRoot, teamId) {
  return `team:${stateRoot}:${teamId}`;
}

/** Process-local lock key enforcing one active team per captain session. */
export function captainLockKey(stateRoot, captainId) {
  return `captain:${stateRoot}:${captainId}`;
}
