/** runtime/members: toolDenyListFor — host-registry-filtered deny lists (I1). */
import { toolDenyListFor, hostToolNames, markMemberRetired, isMemberRetired, installRetiredInboxGuard, deliverToMember, isWriteCapability, seatModelRequest, isQuotaError, setNavRouteFallback, clearNavRouteFallback, navRouteFallbackActive, navRouteFallbackReason } from '../lib/runtime/members.js';

const CLAUDE_NAMES = ['str_replace_editor', 'write_file', 'create_file', 'edit_file', 'apply_patch'];
const DSH_NAMES = ['write', 'edit', 'pwsh'];
const SHELL_NAMES = ['pwsh', 'bash', 'Bash'];
const PAIR_CAPTAIN_NAMES = ['pair_start', 'pair_stop', 'pair_rotate', 'pair_arbitrate', 'pair_interrupt'];

/** A fail-loud refusal must name the role it protects I1 for. */
const I1_MESSAGE = /cannot enforce single-writer I1 without the host tool registry/;

function refusesFor(role, operation) {
  try {
    operation();
  } catch (error) {
    const message = String(error?.message ?? error);
    return I1_MESSAGE.test(message) && message.includes(`role=${role}`);
  }
  return false;
}

export async function run(check) {
  // win32 DSH host: read/write/edit/pwsh registered, Claude-flavored names absent.
  const win32 = ['read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'todo_write', 'subagent', ...PAIR_CAPTAIN_NAMES];
  const navWin = toolDenyListFor('navigator', win32);
  check(DSH_NAMES.every(n => navWin.includes(n)), 'win32 navigator denies DSH write+edit+pwsh');
  check(!CLAUDE_NAMES.some(n => navWin.includes(n)), 'win32 navigator deny excludes unregistered Claude names');
  check(navWin.every(n => win32.includes(n)), 'win32 navigator deny is a subset of known tools');
  check(PAIR_CAPTAIN_NAMES.every(n => navWin.includes(n)), 'win32 navigator denies the five captain pair_* tools');

  // Claude-flavored host: the five legacy names registered, write/edit absent.
  const claude = ['Read', 'Bash', ...CLAUDE_NAMES, ...PAIR_CAPTAIN_NAMES];
  const navCl = toolDenyListFor('challenger', new Set(claude));
  check(CLAUDE_NAMES.every(n => navCl.includes(n)), 'claude host challenger denies the five legacy write names');
  check(navCl.includes('Bash'), 'claude host challenger denies Bash, which is a write capability');
  check(!DSH_NAMES.some(n => navCl.includes(n)), 'claude host challenger deny excludes unregistered DSH names');
  check(navCl.every(n => claude.includes(n)), 'claude host deny list is a subset of known tools');

  // Set and array spellings of knownTools must agree.
  check(JSON.stringify(toolDenyListFor('navigator', win32)) === JSON.stringify(toolDenyListFor('navigator', new Set(win32))), 'knownTools Set/array agree');

  // Driver keeps every write tool on any host.
  const drv = toolDenyListFor('driver', win32);
  check(PAIR_CAPTAIN_NAMES.every(n => drv.includes(n)), 'driver denies captain pair_* tools');
  check(!drv.some(n => [...DSH_NAMES, ...SHELL_NAMES, ...CLAUDE_NAMES].includes(n)), 'driver deny contains no write-tool names');
  check(drv.length === PAIR_CAPTAIN_NAMES.length, 'driver deny is exactly the five pair_* tools');

  // AC-1: a missing registry must refuse to form a team, never silently keep
  // the write tools for a member that is not the Driver (fail-open = I1 dead).
  check(refusesFor('navigator', () => toolDenyListFor('navigator', undefined)), 'undefined knownTools: navigator refuses loudly');
  check(refusesFor('challenger', () => toolDenyListFor('challenger', undefined)), 'undefined knownTools: challenger refuses loudly');
  // AC-1b: an empty registry is indistinguishable from a failed enumeration.
  check(refusesFor('navigator', () => toolDenyListFor('navigator', [])), 'empty array knownTools: navigator refuses loudly');
  check(refusesFor('navigator', () => toolDenyListFor('navigator', new Set())), 'empty Set knownTools: navigator refuses loudly');
  // AC-1c: the Driver is never stripped of write access, so no registry is fine for it.
  const drvUndef = toolDenyListFor('driver', undefined);
  check(drvUndef.length === PAIR_CAPTAIN_NAMES.length, 'driver + undefined knownTools: no throw, exactly the five pair_* tools');

  // AC-1d: a genuinely write-tool-free host registry has nothing to deny —
  // refusing there would be over-throwing, so it must stay silent.
  const noWrites = toolDenyListFor('navigator', ['read', 'glob', ...PAIR_CAPTAIN_NAMES]);
  check(noWrites.length === PAIR_CAPTAIN_NAMES.length, 'registry without write tools: deny stays the five pair_* tools');

  // AC-2: hostToolNames is the producer half of the same contract.
  const winNames = ['read', 'write', 'edit', 'pair_start'];
  const known = hostToolNames({ tools: { schemas: () => winNames.map(name => ({ name })) } });
  check(known instanceof Set && known.size === winNames.length && winNames.every(n => known.has(n)), 'hostToolNames: schemas -> Set of registered names');
  check(hostToolNames({ tools: { schemas: () => { throw new Error('cohort unavailable'); } } }) === undefined, 'hostToolNames: throwing schemas -> undefined');
  check(hostToolNames({ tools: { schemas: () => [] } }) === undefined, 'hostToolNames: empty schema list -> undefined, never an empty Set');
  check(hostToolNames({ tools: { schemas: () => [{}, { id: 'x' }, null, { name: '' }] } }) === undefined, 'hostToolNames: no usable names -> undefined');
  check(hostToolNames({}) === undefined && hostToolNames(undefined) === undefined, 'hostToolNames: absent schemas fn -> undefined');
  const mixed = hostToolNames({ tools: { schemas: () => [{ name: 'read' }, { nope: 1 }, { name: 'write' }] } });
  check(mixed instanceof Set && mixed.size === 2 && mixed.has('write'), 'hostToolNames: usable names kept, malformed entries dropped');
  check(refusesFor('challenger', () => toolDenyListFor('challenger', hostToolNames({ tools: { schemas: () => [] } }))), 'wiring: empty registry reaches toolDenyListFor as undefined and refuses');

  // Retired children are tombstoned at the host inbox boundary, so even a
  // generic cross-team send cannot wake a zombie session.
  const handlers = new Map(); let removed; let followed = false;
  const retiredCtx = {
    on: (name, fn) => { handlers.set(name, fn); },
    logger: { warn: () => {} },
    subagents: { sendMessage: async () => { followed = true; return 'm-1'; } },
  };
  installRetiredInboxGuard(retiredCtx, { stateDir: '.pair-programming' });
  markMemberRetired(retiredCtx, 'old-child');
  check(isMemberRetired(retiredCtx, 'old-child'), 'retirement tombstone is visible in the live plugin context');
  handlers.get('agent/inbox/inserted')({ agent: { id: 'old-child', inbox: { remove: id => { removed = id; } } }, message: { id: 'cross-team-message' } });
  check(removed === 'cross-team-message', 'a generic host message to a retired pair child is removed synchronously');
  const accepted = await deliverToMember(retiredCtx, {}, 'old-child', 'stale', new AbortController().signal);
  check(accepted.ok === false && followed === false, 'pair delivery also refuses a retired child before calling the host');
  check(typeof accepted.reason === 'string' && accepted.reason.length > 0, 'and says why, because a wake that did not happen must never read like one that did');
  // The refusal the host itself gives is the diagnostic the board was missing.
  // Two live sessions went quiet for 244s with "Mail pending for: driver,
  // navigator, challenger" and a stall report that could not name a cause,
  // because the typed SubagentError (DRAINING / ACTIVATION_CLOSING) had already
  // been swallowed into a logger.warn nobody reads.
  const throwing = { logger: { warn: () => {} }, subagents: { sendMessage: async () => { throw new Error('continuable subagents are draining; the operation was not admitted'); } } };
  const refused = await deliverToMember(throwing, {}, 'live-child', 'x', new AbortController().signal);
  check(refused.ok === false && refused.reason.includes('draining'), 'a host refusal is carried out verbatim instead of being logged and dropped');

  // seatModelRequest: the acceptance-definition seat's model override. The
  // oracle is the one artifact whose quality nothing downstream can check, so
  // its seat is the one allowed to route away from the captain — parse rules
  // are pinned here because a wrong split silently routes the WRONG model.
  check(JSON.stringify(seatModelRequest({ navigatorModel: 'deepseek/deepseek-reasoner' }, 'navigator')) === JSON.stringify({ provider: 'deepseek', model: 'deepseek-reasoner' }), 'provider/model splits at the FIRST slash');
  check(JSON.stringify(seatModelRequest({ navigatorModel: 'openrouter/anthropic/claude-3' }, 'navigator')) === JSON.stringify({ provider: 'openrouter', model: 'anthropic/claude-3' }), 'and model ids keep their own slashes');
  check(JSON.stringify(seatModelRequest({ navigatorModel: 'deepseek-reasoner' }, 'navigator')) === JSON.stringify({ model: 'deepseek-reasoner' }), 'a bare model id inherits the captain provider (no provider key)');
  check(JSON.stringify(seatModelRequest({ navigatorModel: '' }, 'navigator')) === '{}' && JSON.stringify(seatModelRequest({}, 'spec')) === '{}', 'empty or absent inherits the captain route wholesale');
  check(JSON.stringify(seatModelRequest({ navigatorModel: 'deepseek/deepseek-reasoner' }, 'driver')) === '{}' && JSON.stringify(seatModelRequest({ navigatorModel: 'deepseek/deepseek-reasoner' }, 'challenger')) === '{}', 'only the acceptance-definition seats (navigator/spec) route away — driver and challenger do not');
  check(JSON.stringify(seatModelRequest({ navigatorModel: ' deepseek/deepseek-reasoner ' }, 'spec')) === JSON.stringify({ provider: 'deepseek', model: 'deepseek-reasoner' }), 'surrounding whitespace is trimmed before parsing');
  // Quota fallback (M20): the sticky flag routes the acceptance seat on the
  // captain's model until a successful route test clears it — and ONLY the
  // acceptance seats; the flag never touches driver/challenger routing.
  check(isQuotaError('Error: 402 You have exceeded your quota, check your plan and billing details') && isQuotaError('insufficient balance') && !isQuotaError('rate limit 429, too many requests') && !isQuotaError('connection refused'), 'quota detection matches exhaustion, not transient rate limits or network noise');
  clearNavRouteFallback();
  check(navRouteFallbackActive() === false && navRouteFallbackReason() === null, 'fallback starts inactive');
  setNavRouteFallback('模型 deepseek/deepseek-reasoner 用量耗尽——navigator 席位已回退为队长模型与配置');
  check(navRouteFallbackActive() === true && navRouteFallbackReason().includes('用量耗尽'), 'a quota death marks the fallback with its reason');
  check(JSON.stringify(seatModelRequest({ navigatorModel: 'deepseek/deepseek-reasoner' }, 'navigator')) === '{}', 'while marked, the acceptance seat inherits the captain route wholesale (sticky)');
  check(JSON.stringify(seatModelRequest({ navigatorModel: 'deepseek/deepseek-reasoner' }, 'driver')) === '{}', 'and the flag never touches non-acceptance seats (they never had an override)');
  clearNavRouteFallback();
  check(JSON.stringify(seatModelRequest({ navigatorModel: 'deepseek/deepseek-reasoner' }, 'navigator')).includes('deepseek-reasoner'), 'a successful route test clears the flag and the premium route returns');
  // The wake seam is ctx.subagents.sendMessage — model-authored mail between
  // adjacent Agents: running target steers at its nearest step boundary, idle
  // target starts a turn, MISSING child cold-resumes from persistence. The
  // service has no followup (that lives on Agent handles — the phantom call
  // starved every delivery into the 120s sweep), and prompt is the browser
  // HUMAN-prompt face: protocol mail must neither impersonate the user nor
  // fail a cold resume. Pin the exact adjacency-contract shape.
  const seen = [];
  const cap = { id: 'cap-1' };
  const signal = new AbortController().signal;
  const sendCtx = { logger: { warn: () => {} }, subagents: { sendMessage: async (sender, targetId, content, options) => { seen.push({ sender, targetId, content, options }); return 'm-1'; } } };
  const delivered = await deliverToMember(sendCtx, cap, 'child-1', 'wake up', signal);
  check(delivered.ok === true && delivered.messageId === 'm-1', 'delivery lands through ctx.subagents.sendMessage and surfaces the inbox MessageId');
  const call = seen[0];
  check(call !== undefined && call.sender === cap, 'the sender is the exact live captain Agent — model mail from the captain, never impersonating the user');
  check(call.targetId === 'child-1', 'and the target is the member session id');
  check(Array.isArray(call.content) && call.content.length === 1 && call.content[0].type === 'text' && call.content[0].text === 'wake up', 'and carries the text as one text ContentBlock');
  check(call.options !== undefined && call.options.signal === signal, 'and passes the caller signal through until inbox acceptance');
  // The spawn filter used to be a list of GUESSED names intersected with the
  // registry: `NON_DRIVER_WRITE_TOOL_CANDIDATES.filter(n => known.has(n))`.
  // That drops every name it did not anticipate, so it failed OPEN on exactly
  // the host it had never seen — and one did: a Challenger ran PowerShell on a
  // host registering its shell as `Pwsh` (capital P, not in the list) and wrote
  // three files into the workspace. Classification is by SHAPE now.
  for (const denied of ['Pwsh', 'PowerShell', 'Write', 'MultiEdit', 'edit_file', 'apply_patch',
    'str_replace_editor', 'run_shell_command', 'execute_command', 'search_and_replace', 'Bash']) {
    check(isWriteCapability(denied), `a non-Driver seat loses "${denied}" — the classifier reads the shape, not a list of names it happens to know`);
  }
  for (const kept of ['read', 'Read', 'glob', 'grep', 'search_files', 'list_directory', 'read_image', 'web_search']) {
    check(!isWriteCapability(kept), `and keeps "${kept}" — a review seat that cannot read cannot review`);
  }
  check(!isWriteCapability('run_code'), 'run_code is exempt and must stay so: it is the host RESERVED TRANSPORT name, restrict() throws on those, and a restricted child resolves its sub-dispatches against the same restricted map anyway');
  check(!isWriteCapability('pair_oracle_write'), 'pair_* tools are governed by role, never by shape — the Navigator authors oracles through exactly this one');
  const navDenied = new Set(toolDenyListFor('navigator', ['read', 'Pwsh', 'Write', 'grep', 'pair_oracle_write', 'run_code']));
  check(navDenied.has('Pwsh') && navDenied.has('Write'), 'the deny list built for a real registry now contains the unguessed names');
  check(!navDenied.has('read') && !navDenied.has('grep') && !navDenied.has('pair_oracle_write') && !navDenied.has('run_code'), 'and nothing the seat needs to do its job');

}
