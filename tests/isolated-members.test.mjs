import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isolatedDriverDenyList } from '../lib/runtime/members.js';
import { createDriverWorktrees } from '../lib/runtime/worktrees.js';
import { spawnIsolatedMember, disposeIsolatedMember, configureIsolatedMembers } from '../lib/runtime/isolated-members.js';
import { coordinationWorkspace, taskWorkspace } from '../lib/runtime/workspace-context.js';
import { captureDelegatedPolicyOverrides } from '@deepseek-ai/dsh-subagent';
export async function run(check) {
  const denied = isolatedDriverDenyList(new Set(['pair_task_claim', 'pair_propose', 'pair_gate_check', 'pair_backlog', 'read', 'Pwsh', 'Edit', 'pair_verify', 'pair_start', 'subagent', 'workflow', 'create_goal']));
  check(denied.join(',') === 'pair_verify,pair_start,subagent,workflow,create_goal', 'isolated Driver keeps implementation/discovery tools but cannot self-review or start competing orchestration');
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
    const replacement = { ...member, id: '' };
    const sibling = { ...member, id: '', name: 'driver2' };
    const siblingSlot = { path: join(root, '.pair-programming/team/worktrees/driver2') };
    team.parallel.slots.driver2 = siblingSlot;
    await spawnIsolatedMember(ctx, { memberMaxDepth: 1 }, parent, team, replacement, 'recovered persona', ['pair_stop']);
    await spawnIsolatedMember(ctx, { memberMaxDepth: 1 }, parent, team, sibling, 'sibling persona', ['pair_stop']);
    await disposeIsolatedMember(ctx, member.id);
    check(coordinationWorkspace(slot.path) === root, 'retiring old Driver preserves replacement worktree routing');
    check(coordinationWorkspace(siblingSlot.path) === root, 'Driver recovery leaves driver2 routing intact');
    await disposeIsolatedMember(ctx, replacement.id);
    check(coordinationWorkspace(slot.path) === slot.path, 'last generation releases its route');
    check(coordinationWorkspace(siblingSlot.path) === root, 'disposing Driver preserves driver2');
    await disposeIsolatedMember(ctx, sibling.id);
    check(disposed === 3, 'all isolated generations disposed once');
    check(coordinationWorkspace(slot.path) === slot.path, 'disposal releases the in-memory route when no durable board exists');
    await disposeIsolatedMember(ctx, member.id);
    check(disposed === 3, 'isolated disposal is idempotent');
    let denied = false;
    try { await spawnIsolatedMember(ctx, { memberMaxDepth: 0 }, parent, team, member, 'persona', []); } catch { denied = true; }
    check(denied, 'isolated native helper enforces delegation depth cap before creation');

    /* ---- A2 (#6): copying delegated policy must never abort a spawn -----
     * The isolated spawn read the child creation context's `agent.session` bare.
     * That service is not injected into the creation context on this host, so the
     * accessor THROWS (`cannot get property "agent" without inject`) instead of
     * returning undefined — and captureDelegatedPolicyOverrides returns an object
     * LITERAL on every host (verified below), so the guard `if (policies)` never
     * tested host capability and the throw aborted the dual-Driver spawn before
     * the child existed. That is why drivers:1 succeeded immediately and only the
     * isolated path was unavailable.
     *
     * Three creation-context shapes are exercised, and ONLY these: this host's
     * shape (the accessor throws, get('agent') is empty), one where the setup-time
     * and created-handle sessions are BOTH reachable (the double-application
     * guard), and one where neither is reachable. Nothing here claims anything
     * about a host whose `agent` service resolves differently during setup. */
    const policySession = name => { const session = { name, appended: [] };
      session.append = (type, payload) => session.appended.push(type); return session; };
    const captainStub = cwd => ({ id: 'cap', options: { provider: 'test', model: 'test' },
      ctx: { get: name => name === 'approval' ? {} : name === 'sandboxPolicy' ? { overrideOf: () => 'workspace-write' } : undefined },
      session: { header: { id: 'cap', cwd }, requestHeader: () => undefined } });
    const childCtxBase = () => ({ on: () => () => {}, get: () => undefined,
      systemPrompt: { context: () => {}, section: () => {}, getContextOrder: () => 1, getSectionOrder: () => 1 },
      tools: { restrict: () => {} } });
    // This host: the property read does not return undefined, it throws.
    const hostShape = () => { const seen = { probed: 0, message: '' }; const childCtx = childCtxBase();
      Object.defineProperty(childCtx, 'agent', { get() { seen.probed += 1;
        seen.message = 'cannot get property "agent" without inject'; throw new Error(seen.message); } });
      return { childCtx, seen }; };
    const spawnInto = setupCtx => handleSession => {
      const registry = { on: () => () => {}, agents: { create: async options => {
        if (typeof options.setup === 'function') await options.setup(setupCtx);
        return { agent: { id: options.sessionId, ...(handleSession ? { session: handleSession } : {}) }, dispose: async () => {} };
      } } };
      return { registry, captain: captainStub(root),
        team: { parallel: { workspace: root, slots: { driver: { path: slot.path } } } },
        member: { name: 'driver', role: 'driver', provider: 'test', model: 'test' } };
    };
    const outcome = async run => {
      try { await spawnIsolatedMember(run.registry, { memberMaxDepth: 1 }, run.captain, run.team, run.member, 'persona', []); return ''; }
      catch (error) { return String(error?.message ?? error); }
    };
    const bare = captureDelegatedPolicyOverrides({ ctx: { get: () => undefined } });
    check(typeof bare === 'object' && bare.approvalPolicy === undefined
      && captureDelegatedPolicyOverrides(captainStub(root)).approvalPolicy === 'never',
    'A2 the captured overrides are a truthy object with AND without an approval service, so the guard never protected the property read');
    const host = hostShape(), hostHandle = policySession('handle');
    const hostFailure = await outcome(spawnInto(host.childCtx)(hostHandle));
    check(hostFailure === '' && host.seen.probed === 1 && host.seen.message === 'cannot get property "agent" without inject',
      'A2 a creation context whose agent accessor throws does not abort the spawn (accessor: ' + (host.seen.message || 'did not throw') + '; spawn error: ' + (hostFailure || 'none') + ')');
    check(hostHandle.appended.length === 2 && hostHandle.appended.join(',') === 'sandbox/mode,approval/policy',
      'A2 the created handle carries the whole delegated policy EXACTLY once (appends=' + hostHandle.appended.length + ' [' + hostHandle.appended.join(',') + '])');
    const setupSession = policySession('setup'), bothHandle = policySession('handle-both');
    const bothCtx = childCtxBase();
    bothCtx.agent = { session: setupSession };
    bothCtx.get = name => name === 'agent' ? { session: setupSession } : undefined;
    const bothFailure = await outcome(spawnInto(bothCtx)(bothHandle));
    check(bothFailure === '' && setupSession.appended.length === 2 && bothHandle.appended.length === 0,
      'A2 when both the setup context and the created handle expose a session the policy lands once, on the setup session (setup=' + setupSession.appended.length + ', handle=' + bothHandle.appended.length + ')');
    const unreachable = hostShape();
    const unreachableFailure = await outcome(spawnInto(unreachable.childCtx)(undefined));
    check(unreachableFailure === '' && unreachable.seen.probed === 1,
      'A2 an unreachable session leaves the policy unapplied instead of failing the spawn (spawn error: ' + (unreachableFailure || 'none') + ')');
  } finally { await rm(root, { recursive: true, force: true }); }
}
