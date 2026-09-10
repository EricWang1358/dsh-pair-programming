/** DSH-owned Agents with plugin-owned lifecycle, for explicit worktree cwd.
 * Stock continuable children cannot override cwd in the tested DSH cohort.
 * No descriptor is forged: the board owns these identities and cold resumes.
 */
import { randomUUID } from 'node:crypto';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { appendDelegatedPolicyOverrides, applyChildComposition, captureDelegatedPolicyOverrides,
  childSessionMeta, resolveChildAgentOptions, resolveChildDepth } from '@deepseek-ai/dsh-subagent';
import { withLock } from '../state/lock.js';
import { stateRootOf } from '../state/layout.js';
import { findTeamByCaptain, readTeam } from '../state/store.js';
import { registerWorkspace, unregisterWorkspace } from './workspace-context.js';
const runtimes = new WeakMap();
export function configureIsolatedMembers(ctx, config) { runtime(ctx).config = config; }
function runtime(ctx) {
  let value = runtimes.get(ctx);
  if (!value) {
    value = { handles: new Map(), routes: new Map(), closing: false };
    runtimes.set(ctx, value);
    ctx.on?.('dispose', async () => {
      value.closing = true;
      await Promise.allSettled([...value.handles.values()].map(handle => handle.dispose()));
      for (const route of value.routes.values()) unregisterWorkspace(route.workspace);
      value.handles.clear();
      value.routes.clear();
    });
  }
  return value;
}
function selectionOf(member) {
  return { provider: member.provider, model: member.model,
    ...(member.reasoningEffort === undefined ? {} : { reasoningEffort: member.reasoningEffort }) };
}
/**
 * Apply the captain's delegated policy overrides to the child's session.
 *
 * `childCtx.agent` is only readable where the host injects the `agent` service
 * into the child's creation context. On hosts where it is not injected the
 * property accessor THROWS (`cannot get property "agent" without inject`)
 * instead of returning undefined — and because `captureDelegatedPolicyOverrides`
 * always returns an object in a host that has an approval service, that throw
 * aborted EVERY isolated (dual-Driver) spawn before the child existed. Copying
 * policy must never be the reason a spawn fails: report it and let the caller
 * retry through the handle returned by `ctx.agents.create`, whose
 * `agent.session` is the same object.
 *
 * @returns {boolean} true when the overrides were applied here.
 */
function applyDelegatedPolicies(childCtx, policies) {
  const candidates = [];
  try {
    candidates.push(childCtx.agent?.session);
  } catch { /* `agent` is not injected on this host */ }
  try {
    candidates.push(typeof childCtx.get === 'function' ? childCtx.get('agent')?.session : undefined);
  } catch { /* no such service in this fiber */ }
  const session = candidates.find(value => value !== undefined);
  if (!session) return false;
  appendDelegatedPolicyOverrides(session, policies);
  return true;
}
function setupFor(parent, member, policies, policyState) {
  return childCtx => {
    if (policies && policyState) {
      if (applyDelegatedPolicies(childCtx, policies)) policyState.applied = true;
    }
    applyChildComposition(childCtx, parent, member.composition);
    installModelSelection(childCtx, { current: selectionOf(member), assembled: undefined });
  };
}
export async function spawnIsolatedMember(ctx, config, captain, team, member, persona, deny, signal) {
  const policies = captureDelegatedPolicyOverrides(captain);
  const depth = resolveChildDepth(captain, config.maxDepth ?? config.memberMaxDepth);
  const owned = runtime(ctx);
  if (owned.closing) throw new Error('isolated member runtime is closing');
  const slot = team.parallel.slots[member.name];
  if (!slot) throw new Error('isolated Driver has no reserved workspace');
  registerWorkspace(slot.path, team.parallel.workspace);
  member.runtime = 'isolated';
  member.workspace = slot.path;
  member.composition = { persona: persona + '\n\nYour seat is ' + member.name
    + '. Your only implementation workspace is ' + slot.path
    + '. Other Drivers own other worktrees. Do not edit their paths or the canonical workspace. '
    + 'Use pair tools for task ownership and messages; never switch branches, reset, commit or merge manually. '
    + 'Protocol tools may be SDK bindings behind run_code: call await tools.pair_status({}) and await tools.pair_task_claim({task_id: ...}) inside run_code when they are not standalone tool schemas. A default.* file-tool list does not mean protocol bindings are absent. Never implement before a successful claim, frozen oracle and GO. '
    + 'After the candidate gate passes, ask the captain to pair_integrate before completing the task.',
    toolFilter: { deny } };
  const policyState = { applied: false };
  const handle = await ctx.agents.create({
    sessionId: 'session-' + randomUUID(),
    meta: { ...childSessionMeta(captain, depth, false), cwd: slot.path },
    agentOptions: resolveChildAgentOptions(captain, selectionOf(member), depth),
    signal, setup: setupFor(captain, member, policies, policyState),
  });
  if (policies && !policyState.applied && handle?.agent?.session) {
    // The setup context could not read `agent` on this host; the created handle
    // carries the same session object.
    appendDelegatedPolicyOverrides(handle.agent.session, policies);
  }
  if (owned.closing || signal?.aborted) { await handle.dispose(); throw new Error('isolated spawn cancelled'); }
  member.id = handle.agent.id;
  owned.handles.set(member.id, handle);
  owned.routes.set(member.id, { captainId: captain.id, teamId: team.id, workspace: member.workspace });
  // No first turn until the complete team record exists. The scheduler sends
  // the first bounded task/oracle obligation after board creation.
}
export async function deliverIsolatedMember(ctx, captain, childId, text, signal) {
  const owned = runtime(ctx);
  if (!owned.config) return undefined;
  const stateRoot = stateRootOf(captain.session.header.cwd, owned.config);
  const route = owned.routes.get(childId);
  let team = route?.captainId === captain.id && route.teamId
    ? await readTeam(stateRoot, route.teamId) : undefined;
  if (!team || team.captainSessionId !== captain.id || !team.members.some(member => member.id === childId)) {
    owned.routes.delete(childId);
    team = await findTeamByCaptain(stateRoot, captain.id);
  }
  const member = team?.members.find(m => m.id === childId && m.runtime === 'isolated');
  if (!member) return undefined;
  owned.routes.set(childId, { captainId: captain.id, teamId: team.id, workspace: member.workspace });
  if (owned.closing || member.status === 'removed' || ['DONE','ABORTED'].includes(team.protocol.phase)) {
    throw new Error('isolated Driver is retired or its team is closed');
  }
  return withLock('isolated-member:' + childId, async () => {
    if (signal?.aborted) throw new Error('isolated delivery cancelled');
    let handle = owned.handles.get(childId);
    if (!handle) {
      // Never borrow/dispose a UI-owned handle that lacks our restored scope.
      if (ctx.agents.get(childId)) throw new Error('isolated Driver is resident outside its owning runtime; close that view before recovery');
      registerWorkspace(member.workspace, team.parallel.workspace);
      handle = await ctx.agents.resume({
        resumeSessionId: childId, agentOptions: selectionOf(member), signal,
        setup: setupFor(captain, member),
      });
      if (handle.agent.session.header.cwd !== member.workspace || owned.closing || signal?.aborted) {
        await handle.dispose(); throw new Error('isolated resume cwd mismatch or cancellation');
      }
      owned.handles.set(childId, handle);
    }
    const latest = await readTeam(stateRootOf(captain.session.header.cwd, owned.config), team.id);
    if (owned.closing || signal?.aborted || !latest?.members.some(m => m.id === childId && m.status !== 'removed')
      || ['DONE','ABORTED'].includes(latest?.protocol.phase)) throw new Error('isolated delivery lost its active seat');
    const message = createUserMessage({ content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-pair-programming' } });
    handle.agent.steer(message);
    return { ok: true, messageId: message.id };
  });
}
export function interruptIsolatedMember(ctx, childId) {
  const handle = runtimes.get(ctx)?.handles.get(childId);
  if (!handle) return false;
  handle.agent.cancel({ kind: 'disposed' });
  return true;
}
export async function disposeIsolatedMember(ctx, childId) {
  const owned = runtimes.get(ctx);
  const handle = owned?.handles.get(childId);
  const route = owned?.routes.get(childId);
  owned?.routes.delete(childId);
  // Recovery generations share a worktree: preserve the surviving route.
  if (route && ![...owned.routes.values()].some(other => other.workspace === route.workspace)) {
    unregisterWorkspace(route.workspace);
  }
  if (!handle) return;
  await handle.dispose();
  owned.handles.delete(childId);
}
