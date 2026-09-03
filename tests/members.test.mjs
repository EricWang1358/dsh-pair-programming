/** runtime/members: toolDenyListFor — host-registry-filtered deny lists (I1). */
import { toolDenyListFor, hostToolNames } from '../lib/runtime/members.js';

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
}
