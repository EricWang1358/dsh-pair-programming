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
 * wakes it with ctx.subagents.sendMessage (model-authored, adjacent-agent
 * steer); it works one turn and becomes idle.
 *
 * @module dsh-pair-programming/runtime/members
 */
import { join } from 'node:path';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { readRetiredMemberIds } from '../state/store.js';

const MEMBER_LABEL_PREFIX = 'pair-programming:';
const RETIRED_BY_CONTEXT = new WeakMap();

/** Tombstone a child for this live plugin context. */
export function markMemberRetired(ctx, childId) {
  let ids = RETIRED_BY_CONTEXT.get(ctx);
  if (ids === undefined) { ids = new Set(); RETIRED_BY_CONTEXT.set(ctx, ids); }
  ids.add(childId);
}

export function isMemberRetired(ctx, childId) {
  return RETIRED_BY_CONTEXT.get(ctx)?.has(childId) === true;
}

/**
 * Drop any generic host message routed to a retired pair child. This closes
 * the cross-team zombie path even when a caller bypasses pair_* delivery.
 */
export function installRetiredInboxGuard(ctx, config) {
  ctx.on?.('agent/inbox/inserted', ({ agent, message }) => {
    if (!isMemberRetired(ctx, agent.id)) return;
    agent.inbox?.remove?.(message.id);
  });
  // Rehydrate tombstones before a restored session begins driving. This uses
  // the durable deny-list that used to be write-only.
  ctx.on?.('agent/session-start', async ({ agent }) => {
    const cwd = agent.session?.header?.cwd;
    if (typeof cwd !== 'string') return;
    try {
      const ids = await readRetiredMemberIds(join(cwd, config?.stateDir ?? '.pair-programming'));
      if (ids.has(agent.id)) {
        markMemberRetired(ctx, agent.id);
        agent.cancel?.({ kind: 'disposed' });
      }
    } catch (error) {
      ctx.logger?.warn?.(`pair-programming: retired-member guard could not load for ${agent.id}: ${String(error)}`);
    }
  });
}

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
  // A shell is also a write capability.  DSH on Windows exposes `pwsh` and
  // Claude-style hosts expose `Bash`; leaving either out made I1 merely a
  // convention because a Navigator could redirect output into production.
  'pwsh',
  'bash',
  'Bash',
];

/**
 * Everything the SPEC seat is allowed to keep. It authors the acceptance
 * oracle and nothing else.
 *
 * This list is the whole v4 argument in one constant. Independence was never
 * produced by giving the reviewer a different NAME — eight measured rounds and
 * three live sessions show a second seat with the same model, the same context
 * and the same reading produces the same wrong answer at double the price. It
 * is produced by writing the acceptance standard at a TIME when the
 * implementation does not exist and cannot be consulted.
 *
 * Time-based asymmetry can be enforced mechanically, and this is where: the
 * plugin runs the oracle command itself inside pair_oracle, so the seat that
 * writes an oracle needs no shell, no editor, no reader, no search. Strip them
 * and "derive the standard from the request alone" stops being an instruction
 * the model may forget under a long context and becomes a property of the
 * sandbox it is in.
 */
const SPEC_ALLOWED_TOOLS = ['pair_oracle_write', 'pair_oracle', 'pair_status', 'pair_mailbox_read'];

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
  if (role === 'spec') {
    // Deny by allow-list: everything the host registers except the two oracle
    // tools. A seat that cannot read the repository cannot have its judgement
    // shaped by an implementation, which is the entire point of the seat.
    const known = knownTools === undefined ? undefined : (knownTools instanceof Set ? knownTools : new Set(knownTools));
    if (known === undefined || known.size === 0) throw unenforceableSpecIsolation();
    return [...new Set([...base, ...[...known].filter(name => !SPEC_ALLOWED_TOOLS.includes(name))])];
  }
  if (role === 'driver') return base;
  // An unreadable registry and an empty one carry the same risk: we cannot know
  // which write names restrict() would accept, so neither may form a team.
  const known = knownTools === undefined ? undefined : (knownTools instanceof Set ? knownTools : new Set(knownTools));
  if (known === undefined || known.size === 0) throw unenforceableI1(role);
  return [...new Set([...base, ...[...known].filter(isWriteCapability)])];
}

/**
 * Whether one registered tool name is a write capability for a non-Driver.
 *
 * The name list alone was not enough, and a live session proved it: a
 * Challenger wrote three files into the workspace and ran PowerShell through
 * a host that registers its shell as `Pwsh`. `NON_DRIVER_WRITE_TOOL_CANDIDATES`
 * carries `pwsh`, the lookup is a case-sensitive Set, and the old
 * `.filter(name => known.has(name))` therefore DROPPED the one entry that
 * mattered — the filter failed OPEN on exactly the name it did not anticipate,
 * turning I1 back into a convention. It threw only when the whole registry was
 * unreadable, never when a write tool existed under an unguessed name.
 *
 * So classification is now by shape, not by membership: any registered name
 * that reads as an editor, a patcher, a file writer, or a shell is denied,
 * whatever generation or casing the host names it in. The explicit candidate
 * list stays as documentation of the two naming generations we know; the
 * pattern is what makes an unfamiliar third one safe. A name we still cannot
 * classify reaches the runtime path guard in `runtime/board-guard.js`, which
 * refuses the call itself — the two layers fail open in different directions
 * on purpose.
 */
export function isWriteCapability(name) {
  if (typeof name !== 'string' || name === '') return false;
  if (name.startsWith('pair_')) return false; // protocol tools are governed by role, not by shape
  if (NON_DRIVER_WRITE_TOOL_CANDIDATES.includes(name)) return true;
  if (SHAPE_EXEMPT.has(name)) return false;
  return WRITE_CAPABILITY_SHAPE.test(name);
}

/**
 * Names the shape test would catch that are not workspace writes.
 *
 * `run_code` is the important one and it is not a judgement call: it is the
 * host's RESERVED TRANSPORT name. `ToolRuntime.restrict()` fails on reserved
 * transport names, so listing it would throw at spawn and break pair_start
 * outright; and denying it would be pointless anyway, because a restricted
 * child's `run_code` sub-dispatches resolve tool names against that child's
 * own restricted visible map — a `Pwsh` denied here is equally invisible
 * inside a code block. The transport is not the hole; the unguessed name was.
 */
const SHAPE_EXEMPT = new Set(['run_code', 'create_goal', 'update_goal']);

/**
 * Editors, patchers, writers, and shells across naming generations and
 * casings. Anchored on word boundaries so `read_file` and `grep` stay
 * readable while `Write`, `MultiEdit`, `apply_patch`, `Pwsh`, `PowerShell`,
 * `run_shell_command`, `execute_command` and `str_replace_editor` do not.
 */
const WRITE_CAPABILITY_SHAPE = /(^|[_-]|(?<=[a-z0-9]))(write|edit|editor|patch|apply|replace|create|delete|remove|rename|mkdir|touch|shell|bash|zsh|pwsh|powershell|cmd|terminal|exec|execute|command)([_-]|$|(?=[A-Z]))/i;

/** The refusal thrown when the spec seat cannot be sealed off from the tree. */
function unenforceableSpecIsolation() {
  return new Error('pair-programming: the SPEC seat cannot be isolated without the host tool registry — its independence is enforced by denying every tool except pair_oracle_write/pair_oracle, and a registry we cannot read might leave a reader or a shell in place. Refusing to form the team rather than shipping an oracle that may have been written while looking at the answer.');
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
 * The per-role model override for the acceptance-definition seats: the
 * Navigator in pair modes, the SPEC seat in solo — both write the oracle, the
 * one artifact whose quality nothing downstream can machine-check. Format:
 * "provider/model" (provider = the prefix before the FIRST '/'; provider ids
 * never contain one, model ids may) or a bare model id (provider inherited
 * from the captain's route). Empty or absent = inherit the captain's route.
 * @returns the request shape resolveMemberLlmSelection accepts, possibly empty.
 */
/**
 * Quota-death signature: the premium route is not merely rate-limited, it is
 * unpaid — retrying it this turn cannot succeed. Rate-limit 429s are
 * deliberately NOT matched (they recover on their own); OpenAI's quota
 * exhaustion rides a 429 but says quota, which is matched.
 */
export function isQuotaError(text) {
  return /quota|insufficient|balance|credit|billing|402|arrears|用量耗尽|余额不足/i.test(String(text ?? ''));
}

/**
 * The sticky fallback: once the acceptance seat's premium route dies of quota
 * exhaustion, every later spawn routes that seat on the captain's model until
 * a successful route test clears it — exactly the recovery contract the
 * settings card advertises. In-process only; the card-facing marker (the
 * derived namespace) survives restarts, and the first quota error after one
 * re-marks and re-falls-back.
 */
let navRouteFallbackDetail = null;
export function navRouteFallbackActive() { return navRouteFallbackDetail !== null; }
export function navRouteFallbackReason() { return navRouteFallbackDetail; }
export function setNavRouteFallback(detail) { navRouteFallbackDetail = String(detail ?? ''); }
export function clearNavRouteFallback() { navRouteFallbackDetail = null; }

export function seatModelRequest(config, role) {
  if (role !== 'navigator' && role !== 'spec') return {};
  // Sticky fallback wins over the composed override: the premium route is
  // known-dead until the user re-selects and a route test passes.
  if (navRouteFallbackDetail !== null) return {};
  const raw = String(config?.navigatorModel ?? '').trim();
  const effort = String(config?.navigatorEffort ?? '').trim();
  const out = {};
  if (raw !== '') {
    const slash = raw.indexOf('/');
    if (slash === -1) out.model = raw;
    else { out.provider = raw.slice(0, slash); out.model = raw.slice(slash + 1); }
  }
  // An effort without a model override is legal: same route, steeper thinking.
  // The 'default' sentinel passes through — resolveMemberLlmSelection maps it
  // to the target model's adapter-owned default.
  if (effort !== '') out.reasoningEffort = effort;
  return out;
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
        ...(llmSelection.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(llmSelection.reasoningEffort) }),
      },
      ...(config.maxDepth !== undefined ? { maxDepth: config.maxDepth } : {}),
    },
    signal,
  })));
  // A host that resolves without a child id would otherwise put a seat with no
  // session on the board: unreachable, un-interruptible, and indistinguishable
  // from a live one. Refusing here keeps the caller's existing failure path —
  // formation rolls back, recycling keeps the live seat.
  if (typeof start?.childId !== 'string' || start.childId === '') {
    throw new Error(`pair-programming: provider "${config.memberProvider}" started ${member.name} without a child session id`);
  }
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
  if (signal?.aborted) return { ok: false, reason: 'wake cancelled before delivery' };
  if (isMemberRetired(ctx, childId)) {
    ctx.logger.warn(`pair-programming: refused prompt to retired member ${childId}`);
    return { ok: false, reason: 'the seat is retired' };
  }
  try {
    // The wake seam is ctx.subagents.sendMessage — model-authored mail between
    // adjacent Agents: a running target admits at its nearest step boundary, an
    // idle target starts a turn, and a MISSING direct child cold-resumes from
    // persistence (the exact post-restart recovery the scheduler exists for).
    // Deliberately NOT ctx.subagents.prompt: that is the browser control face
    // for one HUMAN message — protocol mail would be recorded as user input —
    // and it refuses an absent child (subagent/not-resumable). And never
    // `followup`: it exists on Agent HANDLES, never on the service — the
    // phantom call starved every mailbox delivery into the 120s sweep.
    const messageId = await ctx.subagents.sendMessage(
      captain,
      childId,
      [{ type: 'text', text }],
      { signal: signal ?? new AbortController().signal },
    );
    return { ok: true, messageId };
  } catch (error) {
    // The single most valuable diagnostic this plugin can produce, and it used
    // to end here as a `logger.warn` nobody reads. The host refuses a follow-up
    // with a TYPED error — DRAINING when continuable subagents are shutting
    // down, ACTIVATION_CLOSING when the child is mid-disposal — and that text
    // is the only thing that distinguishes "the board went quiet" from "the
    // board went quiet BECAUSE". Two live sessions showed every seat idle with
    // mail pending and a stall report that could not say why, because the why
    // had already been thrown away here. Carry it out instead.
    const reason = `the host refused the wake: ${String(error?.message ?? error)}`;
    ctx.logger.warn(`pair-programming: prompt to member ${childId} failed: ${String(error)}`);
    return { ok: false, reason };
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

/**
 * Alpha.5 stores a continuable child's `agentOptions` in its descriptor and
 * reapplies them during cold resume. The former registration hook was removed
 * from the public subagent runtime, so model selection now travels solely in
 * the start request above. Keep this facade for the lifecycle tool boundary.
 */
export function installMemberSelectionRuntime() {
  return {
    async withPending(_parentSessionId, _label, _selection, operation) {
      return operation();
    },
  };
}
