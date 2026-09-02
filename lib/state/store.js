/**
 * L1 durable team + protocol state: read/write, task state machine, attempt
 * capability tokens, gate-pass credentials, and the retired-member deny-list.
 *
 * Task state machine and attempt capability adapted from
 * @nanmicoder/dsh-agent-teams `lib/state.js` (MIT) — TASK_TRANSITIONS,
 * transitionError, activateTaskAttempt / beginTaskAttempt /
 * invalidateTaskAttempt — extended with the pair-programming protocol record
 * (phases, cycles, risks, decisions, gate passes) and the hard gate check on
 * task completion.
 *
 * All mutations run inside the caller's per-team lock (state/lock.js); reads
 * may be lock-free. Every mutation is a write-through atomic persist.
 *
 * @module dsh-pair-programming/state/store
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteText, stripLeadingBom } from './atomic.js';
import { withLock, sanitizeKey } from './lock.js';
import { teamFileOf, inboxDirOf, retiredMembersFileOf, teamLockKey } from './layout.js';

/* ------------------------------------------------------------------------- */
/* Task state machine                                                          */
/* ------------------------------------------------------------------------- */

/** The allowed task status transitions, keyed by current status. */
export const TASK_TRANSITIONS = {
  pending: ['claimed', 'cancelled'],
  claimed: ['in_progress', 'failed', 'cancelled'],
  in_progress: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * Validate one task status transition.
 * @returns {string|undefined} the transition error, or undefined when allowed.
 */
export function transitionError(current, next) {
  if (current === next) return undefined;
  if (!TASK_TRANSITIONS[current]?.includes(next)) {
    return `task status cannot move from "${current}" to "${next}"`;
  }
  return undefined;
}

/** Whether every named dependency exists and is completed. */
export function unsatisfiedDependencies(tasks, dependencies) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return dependencies.filter((id) => byId.get(id)?.status !== 'completed');
}

/* ------------------------------------------------------------------------- */
/* Attempt capability tokens                                                   */
/* ------------------------------------------------------------------------- */

/** Activate the task's current generation for one owner and return its capability id. */
export function activateTaskAttempt(task, assignee) {
  const attemptId = randomUUID();
  task.status = 'claimed';
  task.assignee = assignee;
  task.attemptId = attemptId;
  task.handoffId = undefined;
  task.output = undefined;
  task.updatedAt = Date.now();
  return attemptId;
}

/** Start a fresh task generation for one owner. */
export function beginTaskAttempt(task, assignee) {
  task.attempt = (task.attempt ?? 0) + 1;
  return activateTaskAttempt(task, assignee);
}

/**
 * Revoke the current worker immediately. Clearing its capability makes old
 * updates stale; a separate handoff generation serializes async quiescence.
 */
export function invalidateTaskAttempt(task, nextAssignee) {
  task.attemptId = undefined;
  task.handoffId = randomUUID();
  task.status = 'pending';
  task.assignee = nextAssignee;
  task.output = undefined;
  task.updatedAt = Date.now();
}

/* ------------------------------------------------------------------------- */
/* Team record CRUD                                                            */
/* ------------------------------------------------------------------------- */

/** Create the team directory structure and the initial record (inside caller's lock). */
export async function createTeamDir(stateRoot, state) {
  const dir = join(stateRoot, state.id);
  await mkdir(inboxDirOf(stateRoot, state.id), { recursive: true });
  await atomicWriteText(teamFileOf(stateRoot, state.id), JSON.stringify(state, null, 2));
}

/** Read one team record; undefined when absent. */
export async function readTeam(stateRoot, teamId) {
  try {
    const raw = await readFile(teamFileOf(stateRoot, teamId), 'utf8');
    const value = JSON.parse(stripLeadingBom(raw));
    if (!isTeamState(value, teamId)) {
      throw new Error(`invalid pair-programming state in team "${teamId}"`);
    }
    return value;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/**
 * Synchronously read one team record while a continuable child is being
 * composed. Harness requires child setup contributions to be synchronous;
 * this narrow boundary lets a cold-resumed member restore its durable model
 * selection before its first request can be published.
 */
export function readTeamSync(stateRoot, teamId) {
  try {
    const raw = readFileSync(teamFileOf(stateRoot, teamId), 'utf8');
    const value = JSON.parse(stripLeadingBom(raw));
    if (!isTeamState(value, teamId)) {
      throw new Error(`invalid pair-programming state in team "${teamId}"`);
    }
    return value;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/** Persist one team record (inside the caller's lock). */
export async function writeTeam(stateRoot, state) {
  state.updatedAt = Date.now();
  await atomicWriteText(teamFileOf(stateRoot, state.id), JSON.stringify(state, null, 2));
}

/** Delete one team's directory (best effort). */
export async function removeTeamDir(stateRoot, teamId) {
  await rm(join(stateRoot, teamId), { recursive: true, force: true }).catch(() => undefined);
}

/** Find the team owned by one captain session (at most one per captain). */
export async function findTeamByCaptain(stateRoot, captainSessionId) {
  const entries = await listTeamDirs(stateRoot);
  let found;
  for (const teamId of entries) {
    const team = await readTeam(stateRoot, teamId);
    if (team?.captainSessionId === captainSessionId) {
      if (team.protocol.phase === 'DONE') continue; // stopped teams are archived, no longer led (dir kept for audit)
      if (found !== undefined && found.id !== team.id) {
        throw new Error(`captain session leads multiple active teams ("${found.id}", "${team.id}"); archive one before continuing`);
      }
      found = team;
    }
  }
  return found;
}

/** Find the session's team: a live team wins over DONE archives; otherwise the first DONE archive is the deterministic fallback. */
export async function findTeamByParticipant(stateRoot, agentSessionId) {
  const entries = await listTeamDirs(stateRoot);
  let found;
  let archived; // first DONE match, resolved only when no live team matches (M13' r2 prefer-active)
  for (const teamId of entries) {
    const team = await readTeam(stateRoot, teamId);
    const participates = team?.captainSessionId === agentSessionId
      || team?.members.some((m) => m.id === agentSessionId && m.status !== 'removed') === true;
    if (participates && team !== undefined) {
      if (team.protocol.phase === 'DONE') {
        if (archived === undefined) archived = team;
        continue;
      }
      if (found !== undefined && found.id !== team.id) {
        throw new Error(`agent session belongs to multiple active teams ("${found.id}", "${team.id}")`);
      }
      found = team;
    }
  }
  return found ?? archived;
}

async function listTeamDirs(stateRoot) {
  let entries;
  try {
    entries = await readdir(stateRoot, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return entries.filter(e => e.isDirectory() && e.name !== 'cache').map(e => e.name);
}

/* ------------------------------------------------------------------------- */
/* Retired-member deny-list                                                    */
/* ------------------------------------------------------------------------- */

/** Read the durable set of member session ids retired by remove/stop. */
export async function readRetiredMemberIds(stateRoot) {
  try {
    const parsed = JSON.parse(stripLeadingBom(await readFile(retiredMembersFileOf(stateRoot), 'utf8')));
    if (!Array.isArray(parsed) || parsed.some(v => typeof v !== 'string' || v === '')) {
      throw new Error('invalid retired member index');
    }
    return new Set(parsed);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return new Set();
    }
    throw error;
  }
}

/** Atomically add session ids to the durable retired-member deny-list. */
export async function recordRetiredMemberIds(stateRoot, memberIds) {
  const additions = memberIds.filter(id => id !== '');
  if (additions.length === 0) return;
  await withLock(`retired-members:${stateRoot}`, async () => {
    const retired = await readRetiredMemberIds(stateRoot);
    for (const id of additions) retired.add(id);
    await mkdir(stateRoot, { recursive: true });
    await atomicWriteText(retiredMembersFileOf(stateRoot), `${JSON.stringify([...retired].sort(), null, 2)}\n`);
  });
}

/* ------------------------------------------------------------------------- */
/* Gate-pass credentials                                                       */
/* ------------------------------------------------------------------------- */

/** Record a successful gate pass for one task; returns the gate_pass_id. */
export function recordGatePass(team, taskId, checklist) {
  const pass = {
    id: randomUUID(),
    taskId,
    checklist,
    at: Date.now(),
  };
  team.protocol.gatePasses.push(pass);
  return pass;
}

/**
 * Resolve the latest valid (non-stale) gate pass for one task.
 * A pass is stale when the task has advanced (newer cycles/updates) after it.
 */
export function latestGatePass(team, taskId) {
  const passes = team.protocol.gatePasses.filter(p => p.taskId === taskId);
  return passes.length === 0 ? undefined : passes[passes.length - 1];
}

/* ------------------------------------------------------------------------- */
/* Validation                                                                  */
/* ------------------------------------------------------------------------- */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isOptionalString(value) {
  return value === undefined || typeof value === 'string';
}
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isTeamMember(value) {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['name'] === 'string'
    && value['name'].trim() !== ''
    && isOptionalString(value['role'])
    && isOptionalString(value['persona'])
    && isOptionalString(value['provider'])
    && isOptionalString(value['model'])
    && isOptionalString(value['reasoningEffort'])
    && isFiniteNumber(value['joinedAt'])
    && (value['status'] === 'idle' || value['status'] === 'working' || value['status'] === 'removed');
}

function isTeamTask(value) {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['subject'] === 'string'
    && isOptionalString(value['description'])
    && (value['status'] === 'pending'
      || value['status'] === 'claimed'
      || value['status'] === 'in_progress'
      || value['status'] === 'completed'
      || value['status'] === 'failed'
      || value['status'] === 'cancelled')
    && isOptionalString(value['assignee'])
    && Array.isArray(value['dependencies'])
    && value['dependencies'].every((d) => typeof d === 'string')
    && isOptionalString(value['output'])
    && (value['attempt'] === undefined
      || (Number.isSafeInteger(value['attempt']) && value['attempt'] >= 0))
    && isOptionalString(value['attemptId'])
    && isOptionalString(value['handoffId'])
    && isFiniteNumber(value['createdAt'])
    && isFiniteNumber(value['updatedAt']);
}

function isProtocolState(value) {
  return isRecord(value)
    && typeof value['phase'] === 'string'
    && Array.isArray(value['cycles'])
    && Array.isArray(value['risks'])
    && Array.isArray(value['decisions'])
    && Array.isArray(value['gatePasses'])
    && isRecord(value['stats']);
}

/** Validate the full team record before it can participate in authorization. */
function isTeamState(value, expectedId) {
  if (!isRecord(value)) return false;
  return value['id'] === expectedId
    && typeof value['name'] === 'string' && value['name'].trim() !== ''
    && typeof value['goal'] === 'string'
    && (value['mode'] === 'full' || value['mode'] === 'light')
    && typeof value['captainSessionId'] === 'string' && value['captainSessionId'] !== ''
    && isFiniteNumber(value['createdAt'])
    && Array.isArray(value['members']) && value['members'].every(isTeamMember)
    && Array.isArray(value['tasks']) && value['tasks'].every(isTeamTask)
    && Number.isSafeInteger(value['taskSeq']) && value['taskSeq'] >= 0
    && isProtocolState(value['protocol']);
}

export { sanitizeKey, teamLockKey };
