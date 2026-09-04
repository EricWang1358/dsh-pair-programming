/**
 * The captain's write guard: I1 as a sandbox property rather than as prose.
 *
 * M17' is the case this exists for. A captain led a full board, called
 * pair_stop at goal round 22, and then implemented the entire product itself
 * with 24 write and 51 edit calls — outside the cycles, outside the oracles,
 * outside the gate. Every rule the protocol enforces was still true and none
 * of them applied, because none of that work ever touched the board. The
 * completion gate (see protocol/completion.js) closes the exit; this closes the
 * entrance.
 *
 * The rule is narrow on purpose. While a MULTI-SEAT team is live, the captain
 * is a coordinator: invariant I1 already says only the Driver writes
 * workspace files, and this makes the sentence true instead of merely
 * printed. In solo mode the captain IS the builder, so the guard is silent
 * there — the check that keeps solo honest is the frozen oracle, not a seat.
 *
 * What it deliberately does NOT do: it does not police shells. A captain
 * legitimately runs git, tests and inspection commands, and a `pwsh`/`bash`
 * denial would break the coordinating job it is protecting. A determined
 * captain can still redirect a heredoc into a file. That is accepted: this
 * guard removes the accidental bypass — the one that was actually measured,
 * where the model simply reached for `edit` because it was there — not the
 * deliberate one, which the completion gate catches anyway because such work
 * carries no cycle, no oracle and no gate pass.
 *
 * @module dsh-pair-programming/runtime/board-guard
 */
import { isAbsolute, relative, resolve } from 'node:path';
import { stateRootOf } from '../state/layout.js';
import { findTeamByCaptain } from '../state/store.js';

/**
 * Workspace-mutating tool names across both naming generations. Shells are
 * excluded by design (see the module note); this is the accidental-bypass
 * surface, not a sandbox.
 */
const CAPTAIN_MUTATION_TOOLS = new Set([
  'write', 'edit', 'multiedit', 'multi_edit', 'str_replace_editor',
  'write_file', 'create_file', 'edit_file', 'apply_patch',
  'notebook_edit', 'notebookedit', 'NotebookEdit', 'Write', 'Edit', 'MultiEdit',
]);

/** How long one board reading is reused, so a burst of edits is one read. */
const BOARD_CACHE_MS = 2_000;

/** Argument keys that carry a filesystem target across host tool schemas. */
const PATH_KEY = /(^|_)(path|paths|file|files|filename|filenames)$/i;

/** Every filesystem target named anywhere in one call's arguments. */
export function targetPaths(args) {
  const out = [];
  const walk = (value, key) => {
    if (typeof value === 'string') {
      if (key !== undefined && PATH_KEY.test(key)) out.push(value);
      return;
    }
    if (Array.isArray(value)) { for (const item of value) walk(item, key); return; }
    if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  };
  walk(args, undefined);
  return out;
}

/** Whether one target lies inside the workspace tree. */
export function insideWorkspace(workspace, target) {
  const absolute = isAbsolute(target) ? target : resolve(workspace, target);
  const rel = relative(resolve(workspace), absolute);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Decide one pending call. Exported for unit tests: the whole point of this
 * guard is that it is machine-checkable, so it must be testable without a
 * host.
 *
 * @returns {string|undefined} a denial reason, or undefined to allow.
 */
export function captainWriteDenial(team, workspace, name, args) {
  if (team === undefined) return undefined;
  if (team.mode === 'solo') return undefined; // the captain IS the builder
  if (!CAPTAIN_MUTATION_TOOLS.has(name)) return undefined;
  const targets = targetPaths(args);
  const inside = targets.filter(target => insideWorkspace(workspace, target));
  // Every named target is outside the tree (a scratchpad, a temp file): allow.
  if (targets.length > 0 && inside.length === 0) return undefined;
  // Falling through with NO readable target is deliberate. A guard that fails
  // open is the same as no guard on exactly the host whose argument schema we
  // failed to anticipate, so an unreadable write is refused with a reason that
  // says so.
  const where = inside.length > 0 ? `"${inside[0]}"` : 'an unrecognised target';
  return `pair-programming: refused ${name} on ${where}. You are the captain of team "${team.id}" in ${team.mode} mode, where invariant I1 gives workspace writes to the Driver alone — a captain that implements directly produces work with no cycle, no frozen oracle and no gate pass, which pair_stop will refuse to call complete (measured: a full board reached DONE with 0/10 tasks completed and an empty cycle list this way). Do one of: send the change to the Driver as a [PAIR:PROPOSE]-able instruction, or pair_stop(outcome="aborted", reason=...) and take over deliberately. Writes outside this workspace are unaffected.`;
}

/**
 * Install the guard on the host tool pipeline.
 *
 * Registered as a `tools/pre-execute` listener because the decision needs the
 * board on disk, and the synchronous `ctx.tools.guard()` surface cannot read
 * it. Hosts without the waterfall simply do not get the guard; every other
 * enforcement point is unaffected.
 */
export function installBoardWriteGuard(ctx, config) {
  if (typeof ctx.on !== 'function') return () => {};
  const cache = new Map(); // agentId -> { at, team }
  return ctx.on('tools/pre-execute', async (exec, next) => {
    const agent = exec?.agent;
    if (agent === undefined || !CAPTAIN_MUTATION_TOOLS.has(exec.name)) return next();
    const workspace = agent.session?.header?.cwd;
    if (typeof workspace !== 'string') return next();
    let entry = cache.get(agent.id);
    if (entry === undefined || Date.now() - entry.at > BOARD_CACHE_MS) {
      let team;
      try {
        team = await findTeamByCaptain(stateRootOf(workspace, config), agent.id);
      } catch (error) {
        // Multiple active teams, unreadable state: not this guard's business
        // to adjudicate, and it must never become the reason a call fails.
        ctx.logger?.debug?.(`pair-programming: write guard could not read the board: ${String(error)}`);
        return next();
      }
      entry = { at: Date.now(), team };
      cache.set(agent.id, entry);
    }
    const reason = captainWriteDenial(entry.team, workspace, exec.name, exec.arguments);
    return reason === undefined ? next() : { kind: 'deny', reason };
  });
}
