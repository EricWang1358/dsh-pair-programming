/** Task admission and ownership for isolated writers. Default pairing is unchanged. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { scopeConflicts } from './worktrees.js';
import { workspaceFingerprint } from '../tools/oracle-exec.js';

const execute = promisify(execFile);
const live = task => ['claimed', 'in_progress'].includes(task.status);
const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
function literalPath(value) {
  if (typeof value !== 'string' || !value || /[\0*?\[\]:]/u.test(value)) throw new Error('Scope paths must be literal relative paths');
  const path = value.replaceAll('\\', '/').replace(/\/$/u, '');
  if (!path || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Scope path must stay inside its workspace');
  return fold(path);
}
export function taskScope(args) {
  const paths = key => args[key] === undefined ? [] : Array.isArray(args[key]) ? args[key].map(literalPath) : (() => { throw new Error(`${key} must be an array`); })();
  const writes = paths('write_paths'), reads = paths('read_paths');
  const resources = args.resources ?? [];
  if (!Array.isArray(resources) || resources.some(value => typeof value !== 'string' || !value.trim())) throw new Error('resources must contain nonblank shared resource names');
  return { writes, reads, resources: resources.map(value => value.trim()), declared: ['write_paths', 'read_paths', 'resources'].every(key => Array.isArray(args[key])) && writes.length > 0 };
}
export function criticalScope(scope) {
  const manifests = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'cargo.toml', 'cargo.lock', 'go.mod', 'go.sum', 'pyproject.toml', 'uv.lock', 'poetry.lock', 'requirements.txt', 'pom.xml', 'build.gradle']);
  const shared = new Set(['migration', 'migrations', 'schema', 'schemas', 'generated', 'interface', 'interfaces', 'types']);
  return (scope?.writes ?? []).some(path => {
    const parts = String(path).replaceAll('\\', '/').toLowerCase().split('/');
    return manifests.has(parts.at(-1)) || parts.some(part => shared.has(part));
  });
}
export function claimEligibility(team, member, task) {
  if (!team.parallel) return undefined;
  if (member?.role !== 'driver' || member.status === 'removed') return 'Only active Drivers can claim parallel implementation tasks';
  if (task.assignee !== undefined && task.assignee !== member.name) return 'Task belongs to a different Driver';
  if (task.status !== 'pending' && !(live(task) && task.assignee === member.name)) return 'Task is not ready to claim';
  if (team.tasks.some(other => other.id !== task.id && other.assignee === member.name && live(other))) return 'Driver already owns unfinished work';
  if ((task.dependencies ?? []).some(id => team.tasks.find(other => other.id === id)?.status !== 'completed' || !team.parallel.integrations?.[id])) return 'Dependency is not completed and integrated';
  for (const other of team.tasks.filter(other => other.id !== task.id && live(other))) {
    if (!task.scope?.declared || !other.scope?.declared || criticalScope(task.scope) || criticalScope(other.scope) || scopeConflicts(task.scope, other.scope)) return `Task scope conflicts with in-flight ${other.id}; wait for integration and completion`;
  }
  return undefined;
}
export function requireTaskOwner(team, task, agent, cycle) {
  if (!team.parallel) return undefined;
  const member = team.members.find(item => item.id === agent.id && item.status !== 'removed');
  if (!task || member?.role !== 'driver' || task.assignee !== member.name || !live(task) || !task.attemptId) throw new Error('TASK_OWNER: only the active task owner may mutate this attempt');
  if (cycle && (cycle.owner?.memberId !== member.id || cycle.owner?.assignee !== member.name || cycle.owner?.attemptId !== task.attemptId)) throw new Error('TASK_OWNER: this cycle belongs to an old or different attempt');
  return member;
}
export function driverForTask(team, taskId) {
  return team.parallel ? team.tasks.find(task => task.id === taskId)?.assignee ?? 'driver' : 'driver';
}
export function proposalScopeError(team, task, files) {
  if (!team.parallel) return undefined;
  try {
    for (const value of files ?? []) {
      const path = literalPath(value);
      const reserved = ['.git', '.pair-programming', '.pair-oracles', team.parallel.stateRelative].filter(Boolean).map(fold);
      if (reserved.some(root => path === root || path.startsWith(`${root}/`))) return `Proposal targets a reserved path: ${value}`;
      if (task.scope?.declared && !task.scope.writes.some(root => path === root || path.startsWith(`${root}/`))) return `Proposal escapes declared write scope: ${value}`;
    }
  } catch (error) { return error.message; }
  return undefined;
}
async function git(cwd, args) {
  const result = await execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  return result.stdout.trim();
}
export async function requireIntegratedHead(team, taskId) {
  if (!team.parallel) return;
  const head = team.parallel.integrations?.[taskId]?.head;
  if (typeof head !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(head)) throw new Error('INTEGRATION_REQUIRED: no valid integration HEAD');
  try { await git(team.parallel.workspace, ['merge-base', '--is-ancestor', head, 'HEAD']); }
  catch { throw new Error('INTEGRATION_STALE: canonical HEAD no longer contains this integration'); }
}
/** Called under the board lock; only a verified plugin-owned slot can be reset. */
export async function prepareTaskWorkspace(team, member, task, config) {
  if (!team.parallel) return;
  for (const id of task.dependencies ?? []) await requireIntegratedHead(team, id);
  if (live(task)) {
    requireTaskOwner(team, task, { id: member.id });
    return; // Resumption never replaces a live candidate or its attempt capability.
  }
  if (task.workspace || team.protocol.cycles.some(cycle => cycle.taskId === task.id)) throw new Error('TASK_WORKSPACE_INVALIDATED: preserve the prior workspace/cycles; an invalidated attempt requires explicit recovery before reassignment');
  const slot = team.parallel.slots[member.name];
  if (!slot) throw new Error('Driver has no isolated workspace');
  const root = await realpath(resolve(team.parallel.stateRoot, team.id, 'worktrees'));
  const path = await realpath(slot.path);
  const part = relative(root, path);
  if (!part || part.startsWith('..') || isAbsolute(part) || fold(resolve(path)) !== fold(resolve(slot.path))) throw new Error('Refusing a worktree outside the plugin-owned slot');
  if (await git(path, ['symbolic-ref', '--short', 'HEAD']) !== slot.branch) throw new Error('Driver branch changed; preserve it and resolve ownership before reuse');
  const head = await git(team.parallel.workspace, ['rev-parse', 'HEAD']);
  const ignored = (await git(path, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])).split('\0').filter(Boolean).map(value => fold(value.replace(/\/$/u, '')));
  if (ignored.length) {
    const tracked = (await git(path, ['ls-tree', '-r', '--name-only', '-z', head])).split('\0').filter(Boolean).map(fold);
    if (ignored.some(a => tracked.some(b => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)))) throw new Error('Driver ignored artifacts overlap files in the new canonical tree; preserve them before reuse');
  }
  const previous = team.tasks.filter(other => other.id !== task.id && other.workspace === slot.path).at(-1);
  if (previous) {
    const candidate = team.parallel.integrations?.[previous.id]?.candidate;
    if (previous.status !== 'completed' || !candidate || candidate.worktreeSha !== await workspaceFingerprint(path, { stateDir: config.stateDir })) throw new Error('Previous Driver candidate has unknown or unintegrated edits; preserve the worktree');
  } else if (await git(path, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('Driver worktree contains unknown edits; preserve them before claiming');
  // Verified path, branch and exact previous reviewed content above. No git clean:
  // untracked old artifacts remain visible and must be included by the next gate.
  await git(path, ['reset', '--hard', head]);
  task.workspace = slot.path; task.baseHead = head; slot.baseHead = head;
}
