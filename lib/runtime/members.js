/**
 * Member subagent lifecycle: spawn one durable continuable child per role,
 * deliver mailbox messages into its FIFO turn queue, and observe activity.
 *
 * Adapted from @nanmicoder/dsh-agent-teams `lib/members.js` (MIT) —
 * spawnMember / deliverToMember / interruptMember /
 * resolveMemberLlmSelection / installMemberSelectionRuntime — retargeted to
 * this plugin's team record and role personas.
 *
 * Members are durable continuable subagents of the captain: a member keeps
 * its conversation across turns and across harness restarts. The captain
 * wakes it with ctx.subagents.followup; it works one turn and becomes idle.
 *
 * @module dsh-pair-programming/runtime/members
 */
import { join } from 'node:path';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { readRetiredMemberIds, readTeamSync } from '../state/store.js';

const MEMBER_LABEL_PREFIX = 'pair-programming:';

/**
 * Captain-only tools a member must never call. Members work through the
 * flow/risk tools; team lifecycle and arbitration belong to the captain.
 */
const MEMBER_DENIED_TOOLS = [
  'pair_start',
  'pair_stop',
  'pair_rotate',
  'pair_arbitrate',
  'pair_interrupt',
];

/**
 * Write-tool candidates denied to non-Driver members (single-writer
 * invariant I1), spanning both tool-naming generations: the DSH core names
 * and the legacy Claude-flavored editor names. A given host registers only
 * one generation, and any subset — these are candidates, filtered against
 * the host registry below before ever reaching restrict(), which THROWS on
 * names it does not know (even in a deny list).
 */
const NON_DRIVER_WRITE_TOOL_CANDIDATES = [
  'write',
  'edit',
  'str_replace_editor',
  'write_file',
  'create_file',
  'edit_file',
  'apply_patch',
];

/**
 * The toolFilter deny-list for one role. The Driver keeps write tools;
 * Navigator and Challenger lose them (physical enforcement of I1).
 *
 * Fail-loud contract: when the host registry could not be read (undefined) or
 * came back empty, a non-Driver role is REFUSED with an Error instead of being
 * handed a deny list that silently still contains the write tools. A broken
 * enumeration must abort pair_start visibly; it must never degrade into an
 * unenforced I1. A driver role never throws, and a registry that genuinely has
 * no write tool registered has nothing to deny — that stays silent.
 *
 * @param {string} role - the member role.
 * @param {Set<string> | string[] | undefined} knownTools - the tool names
 *   the host registry actually has; write candidates are filtered to this
 *   set so restrict() never sees an unknown name. The four captain-only
 *   pair_* tools are always included (this plugin registers them itself).
 */
export function toolDenyListFor(role, knownTools) {
  const base = [...MEMBER_DENIED_TOOLS];
  if (role === 'driver') return base;
  // An unreadable registry and an empty one carry the same risk: we cannot know
  // which write names restrict() would accept, so neither may form a team.
  const known = knownTools === undefined ? undefined : (knownTools instanceof Set ? knownTools : new Set(knownTools));
  if (known === undefined || known.size === 0) throw unenforceableI1(role);
  return [...base, ...NON_DRIVER_WRITE_TOOL_CANDIDATES.filter(name => known.has(name))];
}

/** The refusal thrown when I1 cannot be physically enforced for one role. */
function unenforceableI1(role) {
  return new Error(`pair-programming: role=${role} cannot enforce single-writer I1 without the host tool registry — check SDK ToolRuntime.schemas() cohort`);
}

/**
 * Resolve one member's complete model selection. Ordinary members snapshot the
 * captain's current request route and reasoning effort. When provider or model
 * changes, effort is intentionally omitted so the target model materializes
 * its own default. An explicit effort overrides either policy; the sentinel
 * "default" also selects the target model's default.
 */
export async function resolveMemberLlmSelection(ctx, captain, request, signal) {
  const explicitProvider = request.provider?.trim();
  const explicitModel = request.model?.trim();
  const defaultModel = request.defaultModel?.trim();
  const explicitEffort = request.reasoningEffort?.trim();
  const current = captain.session.requestHeader()?.config;
  const currentProvider = current?.provider ?? captain.options.provider;
  const currentModel = current?.model ?? captain.options.model;
  const provider = explicitProvider ?? currentProvider;
  const model = explicitModel ?? defaultModel ?? currentModel;
  if (provider === undefined || model === undefined) {
    throw new Error('cannot resolve the member LLM route from the current captain session');
  }
  const sameRoute = provider === currentProvider && model === currentModel;
  const reasoningEffort = explicitEffort === undefined
    ? (sameRoute ? current?.reasoningEffort : undefined)
    : explicitEffort === 'default'
      ? undefined
      : ReasoningEffortId(explicitEffort);
  const resolved = await ctx.llm.resolveCallConfig({
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }, signal);
  return {
    provider: resolved.provider,
    model: resolved.model,
    ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: String(resolved.reasoningEffort) }),
  };
}

/**
 * Spawn one member as a durable continuable subagent of the captain and fill
 * `member.id` with its child session id. On failure nothing is persisted.
 *
 * @param {object} personaText - the fully-rendered role system prompt.
 */
export async function spawnMember(ctx, config, selections, llmSelection, captain, team, member, personaText, signal) {
  const provider = ctx.subagents.getProvider(config.memberProvider);
  if (provider === undefined) {
    throw new Error(`pair-programming: no subagent provider "${config.memberProvider}" is registered (available: ${ctx.subagents.list().join(', ') || 'none'}) — check that the base bundle's subagent provider row is mounted in the composition`);
  }
  if (provider.prepareContinuable === undefined) {
    throw new Error(`pair-programming: provider "${config.memberProvider}" does not support continuable members`);
  }
  if (!provider.capabilities.persona) {
    throw new Error(`pair-programming: provider "${config.memberProvider}" cannot apply a member persona`);
  }
  if (!provider.capabilities.toolFilter) {
    throw new Error(`pair-programming: provider "${config.memberProvider}" cannot restrict tools for members`);
  }
  const knownTools = hostToolNames(ctx);
  const label = `${MEMBER_LABEL_PREFIX}${team.id}:${member.name}`;
  const start = await selections.withPending(captain.id, label, llmSelection, () => (ctx.subagents.startContinuable({
    provider: config.memberProvider,
    label,
    request: {
      prompt: [{ type: 'text', text: member.welcome }],
      parent: captain,
      persona: personaText,
      toolFilter: { deny: toolDenyListFor(member.role, knownTools) },
      agentOptions: {
        provider: llmSelection.provider,
        model: llmSelection.model,
      },
      ...(config.maxDepth !== undefined ? { maxDepth: config.maxDepth } : {}),
    },
    signal,
  })));
  member.id = start.childId;
}

/**
 * Every tool name the host registry has globally, via the public
 * ToolRuntime.schemas() view. Returns undefined — NEVER an empty Set — when
 * enumeration is unavailable or produced no usable name, so that
 * toolDenyListFor can distinguish "the registry has no write tool" from "we
 * could not read the registry" and refuse to form a team on the latter.
 *
 * @param {object} ctx - the plugin runtime context.
 * @returns {Set<string> | undefined} registered names, or undefined on failure.
 */
export function hostToolNames(ctx) {
  let schemas;
  try {
    if (typeof ctx?.tools?.schemas !== 'function') return undefined;
    schemas = ctx.tools.schemas();
  } catch {
    return undefined;
  }
  if (!Array.isArray(schemas)) return undefined;
  const names = new Set();
  for (const schema of schemas) {
    const name = typeof schema?.name === 'string' ? schema.name : '';
    if (name !== '') names.add(name);
  }
  return names.size > 0 ? names : undefined;
}

/**
 * Deliver one message to a member as its next FIFO turn. Best effort: a
 * failure is logged and reported as false so the caller can decide (the
 * durable mailbox delivery already happened).
 */
export async function deliverToMember(ctx, captain, childId, text, signal) {
  try {
    await ctx.subagents.followup(captain, childId, [{ type: 'text', text }], {
      source: { kind: 'plugin', plugin: 'dsh-pair-programming' },
      signal,
    });
    return true;
  } catch (error) {
    ctx.logger.warn(`pair-programming: followup to member ${childId} failed: ${String(error)}`);
    return false;
  }
}

/** Request cancellation of one live member's current turn; false when the host refused. */
export function interruptMember(ctx, captain, childId) {
  try {
    ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: captain });
    return true;
  } catch (error) {
    ctx.logger.warn(`pair-programming: interrupt of member ${childId} failed: ${String(error)}`);
    return false;
  }
}

function pendingSelectionKey(parentSessionId, label) {
  return `${parentSessionId}\0${label}`;
}

function selectionFromMember(member) {
  if (member?.provider === undefined || member.model === undefined) return undefined;
  const provider = member.provider.trim();
  const model = member.model.trim();
  if (provider === '' || model === '') return undefined;
  const reasoningEffort = member.reasoningEffort?.trim();
  return {
    provider,
    model,
    ...(reasoningEffort === undefined || reasoningEffort === '' ? {} : { reasoningEffort }),
  };
}

function modelSelection(selection) {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }),
  };
}

/**
 * Install the member selection bridge for every fresh or cold-resumed
 * continuable child. Fresh creation reads the pending in-memory selection;
 * cold resume restores the same selection from the owning team's durable
 * record.
 */
export function installMemberSelectionRuntime(ctx, stateDir) {
  const pending = new Map();
  ctx.subagents.registerContinuableSetup((childCtx) => {
    const child = childCtx.agent;
    if (child === undefined) return () => undefined;
    const suffix = child.session.events.slice(child.session.header.seedLength ?? 0);
    const descriptor = foldSubagentDescriptor(suffix);
    if (descriptor?.mode !== 'continuable' || !descriptor.label.startsWith(MEMBER_LABEL_PREFIX)) {
      return () => undefined;
    }
    const parentSessionId = child.session.header.parentSession;
    if (parentSessionId === undefined) return () => undefined;
    const key = pendingSelectionKey(parentSessionId, descriptor.label);
    let selection = pending.get(key);
    if (selection === undefined) {
      const identity = descriptor.label.slice(MEMBER_LABEL_PREFIX.length);
      const separator = identity.indexOf(':');
      if (separator < 1 || separator === identity.length - 1) return () => undefined;
      const teamId = identity.slice(0, separator);
      const memberName = identity.slice(separator + 1);
      const workspace = child.session.header.cwd ?? process.cwd();
      const team = readTeamSync(join(workspace, stateDir), teamId);
      if (team?.captainSessionId !== parentSessionId) return () => undefined;
      selection = selectionFromMember(team.members.find(m => m.name === memberName));
      if (selection === undefined) return () => undefined;
      if (descriptor.agentProvider !== selection.provider || descriptor.agentModel !== selection.model) {
        throw new Error(`pair-programming: saved model route for member "${memberName}" does not match its subagent descriptor`);
      }
    }
    return installModelSelection(childCtx, {
      current: modelSelection(selection),
      assembled: undefined,
    });
  });
  return {
    async withPending(parentSessionId, label, selection, operation) {
      const key = pendingSelectionKey(parentSessionId, label);
      if (pending.has(key)) {
        throw new Error(`member model selection is already pending for "${label}"`);
      }
      pending.set(key, selection);
      try {
        return await operation();
      } finally {
        pending.delete(key);
      }
    },
  };
}
