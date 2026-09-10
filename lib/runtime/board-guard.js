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
import { isAbsolute, relative, resolve, dirname } from 'node:path';
import { realpath } from 'node:fs/promises';
import { stateRootOf } from '../state/layout.js';
import { findTeamByParticipant } from '../state/store.js';
import { isWriteCapability } from './members.js';
import { allowedWriteSet, withinScope } from '../protocol/scope.js';

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
const isolatedEditor = name => isWriteCapability(name) && !/(shell|bash|zsh|pwsh|powershell|cmd|terminal|exec|execute|command)/i.test(name);

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
 * Decide one pending call, for whichever seat is making it. Exported for unit
 * tests: the whole point of this guard is that it is machine-checkable, so it
 * must be testable without a host.
 *
 * Two seats can break the single-writer invariant, and both were observed
 * doing it in one live session:
 *
 * - the CAPTAIN, which called pair_stop and then built the product itself with
 *   24 write and 51 edit calls (M17');
 * - a NON-DRIVER MEMBER: a Challenger wrote three files into the workspace and
 *   ran PowerShell, having reasoned explicitly that "a throwaway probe file is
 *   not production code". The spawn-time filter was supposed to make that
 *   impossible and failed open on a host naming its shell `Pwsh`.
 *
 * The spawn filter is still the first line — it removes the tools — but a
 * filter can only deny names it recognises. This guard denies by what the call
 * would DO, so an unfamiliar name buys nothing.
 *
 * Shells differ by seat, deliberately. For the captain they stay open: a
 * coordinator needs `git`, and denying shells would break the job this guard
 * exists to protect. For a non-Driver member they do not — I1 says in as many
 * words that a general shell is a write capability, the plugin runs oracles
 * and gates itself, and the measured bypass went straight through one.
 *
 * @returns {string|undefined} a denial reason, or undefined to allow.
 */
export function boardWriteDenial(team, agentId, workspace, name, args) {
  if (name === 'str_replace_editor' && args?.command === 'view') return undefined;
  if (team === undefined) return undefined;
  // A finished board governs nobody. This is the escape hatch: pair_stop
  // (complete or aborted) is how a captain takes the tree over deliberately,
  // and the taking-over is recorded rather than silent. findTeamByParticipant
  // deliberately falls back to an archive so pair_status can still read one,
  // so the guard has to make this distinction itself.
  const phase = team.protocol?.phase;
  if (phase === 'DONE' || phase === 'ABORTED') return undefined;
  if (team.captainSessionId === agentId) return captainWriteDenial(team, workspace, name, args);
  const member = (team.members ?? []).find(m => m.id === agentId && m.status !== 'removed');
  if (member === undefined) return undefined;      // not a seat on this board
  if (member.role === 'driver') {
    if (!team.parallel || !isolatedEditor(name)) return undefined;
    const targets = targetPaths(args);
    if (targets.length === 0) return 'pair-programming: isolated Driver editor has an unrecognised target; use an explicit path';
    for (const target of targets) {
      if (target.replaceAll('\\', '/').split('/').includes('..')) return 'pair-programming: isolated editor paths cannot contain parent traversal; use a direct path within the workspace';
      if (!insideWorkspace(workspace, target)) return 'pair-programming: isolated Driver writes must stay inside its own workspace';
      const path = relative(resolve(workspace), resolve(workspace, target)).replaceAll('\\', '/').toLowerCase();
      const reserved = ['.git', '.pair-programming', '.pair-oracles', team.parallel.stateRelative].filter(Boolean).map(value => value.toLowerCase());
      if (reserved.some(root => path === root || path.startsWith(`${root}/`))) return 'pair-programming: isolated Driver cannot edit reserved Git, board or oracle paths';
    }
    const task = (team.tasks ?? []).find(item => item.assignee === member.name && ['claimed', 'in_progress'].includes(item.status) && item.attemptId);
    if (!task) return 'pair-programming: call pair_task_claim before editing; protocol bindings may require run_code with await tools.pair_task_claim({task_id: ...})';
    const cycles = (team.protocol.cycles ?? []).filter(item => item.taskId === task.id);
    const cycle = cycles.at(-1);
    if (!cycle || cycle.owner?.memberId !== agentId || cycle.owner?.attemptId !== task.attemptId
      || !['GO', 'RED', 'GREEN', 'IMPLEMENTED', 'REFACTOR'].includes(cycle.step)) {
      return 'pair-programming: wait for the frozen oracle, then pair_propose and GO on the current attempt before editing';
    }
    // ONE allowed write set (protocol/scope.js). This guard used to derive its
    // own — `scope.declared ? scope.writes : this cycle's proposal.files` —
    // while integration derived a third from `scope.writes.length`, so a file
    // admitted here could be refused at merge time. Measured: a probe at
    // scratch/regression/pool-link-guard.mjs was legal to propose, legal to
    // write, and rejected by pair_integrate as escaping the declared scope.
    // The set spans every cycle of the task, because integration snapshots the
    // whole candidate and a guard narrower than that is the same divergence.
    const { allowed } = allowedWriteSet(task, cycles);
    for (const target of targets) {
      const scopedPath = relative(resolve(workspace), resolve(workspace, target)).replaceAll('\\', '/');
      if (!withinScope(allowed, scopedPath)) {
        return 'pair-programming: editor target is outside the current task write scope';
      }
    }
    return undefined;
  }
  if (!isWriteCapability(name)) return undefined;
  const targets = targetPaths(args);
  const inside = targets.filter(target => insideWorkspace(workspace, target));
  if (targets.length > 0 && inside.length === 0) return undefined;
  const what = targets.length === 0
    ? `${name} (a general shell is a write capability, and this seat is not the writer)`
    : `${name} on "${inside[0]}"`;
  return `pair-programming: refused ${what}. You are ${member.name} (role=${member.role}) on team "${team.id}", and invariant I1 gives every workspace write to the Driver alone. A probe file, a scratch artifact and production code are the same thing to this rule, because the rule is about who may change the tree — not about what the change is for. Measured: a seat wrote .pair-probes/*.html and two PNGs into the workspace after reasoning that a throwaway probe "is not production code". Ask the Driver to produce what you need, or file what you cannot check as a pair_risk. Acceptance artifacts go through pair_oracle_write, which writes only under the current team artifact_root from pair_status followed by <task_id>/.`;
}

/**
 * The captain half of {@link boardWriteDenial}, kept separate because its rule
 * genuinely differs: solo exempts it entirely and shells stay open in every
 * mode.
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
    if (agent === undefined) return next();
    if (exec.name === 'str_replace_editor' && exec.arguments?.command === 'view') return next();
    // Only calls that could change the tree pay for a board read. Both sets
    // are consulted because the two seats have different rules: the captain's
    // is editors-only, a member's includes shells.
    if (!CAPTAIN_MUTATION_TOOLS.has(exec.name) && !isWriteCapability(exec.name)) return next();
    const workspace = agent.session?.header?.cwd;
    if (typeof workspace !== 'string') return next();
    let entry = cache.get(agent.id);
    if (entry === undefined || entry.team?.parallel || Date.now() - entry.at > BOARD_CACHE_MS) {
      let team;
      try {
        // Resolves a captain OR a member, preferring a live team over an
        // archive — the guard must find the seat whichever chair it sits in.
        team = await findTeamByParticipant(stateRootOf(workspace, config), agent.id);
      } catch (error) {
        // Multiple active teams, unreadable state: not this guard's business
        // to adjudicate, and it must never become the reason a call fails.
        ctx.logger?.debug?.(`pair-programming: write guard could not read the board: ${String(error)}`);
        return next();
      }
      entry = { at: Date.now(), team };
      cache.set(agent.id, entry);
    }
    const reason = boardWriteDenial(entry.team, agent.id, workspace, exec.name, exec.arguments);
    if (reason !== undefined) return { kind: 'deny', reason };
    if (entry.team?.parallel && entry.team.members.some(member => member.id === agent.id && member.role === 'driver') && isolatedEditor(exec.name)) {
      try {
        const root = await realpath(workspace);
        for (const target of targetPaths(exec.arguments)) {
          let current = resolve(workspace, target);
          for (;;) {
            try {
              const actual = await realpath(current);
              if (actual !== root && !insideWorkspace(root, actual)) return { kind: 'deny', reason: 'pair-programming: target resolves outside the isolated Driver workspace' };
              if (actual !== root) {
                const resolvedTarget = resolve(actual, relative(current, resolve(workspace, target)));
                const resolvedReason = boardWriteDenial(entry.team, agent.id, root, exec.name, { path: resolvedTarget });
                if (resolvedReason) return { kind: 'deny', reason: resolvedReason };
              }
              break;
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
              const parent = dirname(current);
              if (parent === current) throw error;
              current = parent;
            }
          }
        }
      } catch { return { kind: 'deny', reason: 'pair-programming: cannot verify the isolated editor target; refused without changing files' }; }
    }
    return next();
  });
}