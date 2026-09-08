import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDriverWorktrees } from '../lib/runtime/worktrees.js';
import { spawnIsolatedMember, disposeIsolatedMember, configureIsolatedMembers } from '../lib/runtime/isolated-members.js';
import { coordinationWorkspace, taskWorkspace } from '../lib/runtime/workspace-context.js';
export async function run(check) {
  // Public DSH delegation helpers execute here. Native profile acceptance adds
  // real registry publication, model turns, lifecycle and persisted sessions.
  const root = await mkdtemp(join(tmpdir(), 'pair-isolated-members-'));
  try {
    const slot = { path: join(root, '.pair-programming/team/worktrees/driver') };
    const team = { parallel: { workspace: root, slots: { driver: slot } } };
    const member = { name: 'driver', role: 'driver', provider: 'test', model: 'test' };
    const parent = { id: 'cap', ctx: { get: () => undefined }, options: { provider: 'test', model: 'test' },
      session: { header: { id: 'cap', cwd: root }, requestHeader: () => undefined } };
    let creation;
    let disposed = 0;
    const ctx = { on() {}, agents: { create: async options => {
      creation = options;
      return { agent: { id: options.sessionId }, dispose: async () => { disposed++; } };
    } } };
    configureIsolatedMembers(ctx, { stateDir: '.pair-programming' });
    await spawnIsolatedMember(ctx, { memberMaxDepth: 1 }, parent, team, member, 'persona', ['pair_stop']);
    check(creation.meta.cwd === slot.path && parent.session.header.cwd === root, 'isolated creation uses real per-agent cwd without mutating parent');
    check(creation.meta.parentSession === 'cap' && creation.meta.delegationDepth === 1, 'isolated creation preserves native delegation lineage/depth');
    check(member.runtime === 'isolated' && typeof member.id === 'string' && member.composition.toolFilter.deny.includes('pair_stop'), 'isolated durable member retains identity and composition for resume');
    check(coordinationWorkspace(slot.path) === root, 'isolated physical cwd maps to central coordination root');
    check(taskWorkspace({ ...team, tasks: [{id:'t-1', assignee:'driver', workspace:slot.path}] }, 't-1', root) === slot.path, 'candidate commands resolve task workspace');
    check(taskWorkspace({ ...team, tasks: [{id:'t-1', status:'completed'}] }, 't-1', root, {closure:true}) === root, 'completed recertification resolves integrated canonical workspace');
    await disposeIsolatedMember(ctx, member.id);
    check(disposed === 1, 'isolated runtime disposes owned handle exactly once');
    check(coordinationWorkspace(slot.path) === slot.path, 'disposal releases the in-memory route when no durable board exists');
    await disposeIsolatedMember(ctx, member.id);
    check(disposed === 1, 'isolated disposal is idempotent');
    let denied = false;
    try { await spawnIsolatedMember(ctx, { memberMaxDepth: 0 }, parent, team, member, 'persona', []); } catch { denied = true; }
    check(denied, 'isolated native helper enforces delegation depth cap before creation');
  } finally { await rm(root, { recursive: true, force: true }); }
}
