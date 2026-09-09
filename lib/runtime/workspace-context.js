/** Resolve coordination separately from a member's physical Git worktree. */
import { readFileSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
const roots = new Map();
export function registerWorkspace(workspace, coordination) {
  roots.set(resolve(workspace), resolve(coordination));
}
export function unregisterWorkspace(workspace) {
  if (typeof workspace === 'string') roots.delete(resolve(workspace));
}
export function coordinationWorkspace(workspace) {
  const path = resolve(workspace);
  if (roots.has(path)) return roots.get(path);
  // Cold reconstruction is bounded to the expected layout and verified against
  // the central board. Never follow a cwd pointer supplied by a model.
  if (['driver', 'driver2'].includes(basename(path)) && basename(dirname(path)) === 'worktrees') {
    const teamDir = dirname(dirname(path));
    try {
      const team = JSON.parse(readFileSync(join(teamDir, 'team.json'), 'utf8').replace(/^\uFEFF/, ''));
      const root = team.parallel?.workspace;
      if (typeof root === 'string' && Object.values(team.parallel.slots ?? {}).some(slot => resolve(slot.path) === path)
        && resolve(team.parallel.stateRoot, team.id) === teamDir) {
        registerWorkspace(path, root);
        return resolve(root);
      }
    } catch { /* An unverified mapping remains a normal workspace. */ }
  }
  return path;
}
export function taskWorkspace(team, taskId, fallback, { closure = false } = {}) {
  if (!team.parallel) return fallback;
  const task = team.tasks.find(t => t.id === taskId);
  if (!task) throw new Error('unknown task workspace');
  if (closure && task.status === 'completed') return team.parallel.workspace;
  const slot = team.parallel.slots[task.assignee];
  if (!slot || !task.workspace || resolve(slot.path) !== resolve(task.workspace)) {
    throw new Error('TASK_WORKSPACE_UNASSIGNED: claim this task on an available Driver before authoring or verifying its oracle');
  }
  return slot.path;
}
