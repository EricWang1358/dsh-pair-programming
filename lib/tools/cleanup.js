/**
 * pair_cleanup: the Captain reclaims the space THIS pair run made, in two phases.
 *
 * The problem it exists for: the plugin's own working state accumulates (driver worktrees,
 * the evidence cache) and the only remedy was deleting directories by hand - which, when the
 * identification is wrong, has no fallback at all. So the destructive act becomes reviewable:
 * a PLAN lists exactly what would go and what stays, with sizes and reasons; EXECUTION needs
 * the plan's token, and a tree that moved since the plan refuses and asks for a new one,
 * because the token IS the binding between what was reviewed and what would be removed.
 *
 * Shapes, deliberately:
 *  - LEVELS ARE STRATEGIES. A level declares what it ADDS over its base (see LEVELS); it is
 *    data with resolver functions, not an if-chain, so a new level is a new entry and the
 *    executor never learns its name. `resolveEntries` is exported so that claim is testable.
 *  - THE OPERATION IS A STATE MACHINE with one guard: `plan` produces { level, entries,
 *    token }; `execute` accepts only that tuple, recomputes it, and refuses on any
 *    difference. There is no third transition, and nothing else may delete.
 *  - PRECONDITIONS ARE CHECKED ONCE, in `assertCleanable`, before either transition.
 *
 * Three guards, each from a scar of this project: a live team refuses (those paths are what
 * an in-flight cycle relies on); only the calling session's own workspace is touched; and only
 * exact plugin-written paths are listed - no globs, so a file this plugin did not create
 * cannot be matched by accident.
 *
 * What BOTH levels keep is the point of "full means regenerable, not everything": boards
 * (archived teams included), the arbitration log, the retrospective, the process lessons, the
 * retired-member deny-list and the FROZEN ORACLES - the evidence a completion was judged on.
 * A user who wants the space truly back should delete the folders themselves, and the tool
 * says so instead of doing it for them.
 *
 * Known omissions, stated rather than implied: mailbox JSONL is kept as a delivery record
 * (small, and the audit trail for at-least-once delivery); orphaned .pair-oracles/ task
 * directories from deleted teams are kept and only REPORTED, because deciding that an oracle
 * is unreferenced needs a board that no longer exists; and deletion is not transactional - a
 * failure midway leaves the rest in place, which the execute result reports path by path.
 *
 * @module dsh-pair-programming/tools/cleanup
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { readTeam, listTeamDirs } from '../state/store.js';
import { cacheDirOf } from '../state/layout.js';
import { isDispatchClosed } from '../protocol/machine.js';
import { coordinationWorkspace } from '../runtime/workspace-context.js';
import { requireAgent, requireParticipantTeam, stateRootFor, workspaceOf, isCaptain } from './shared.js';

/**
 * The level lattice. `adds` returns the paths a level contributes on top of its base; the
 * base is resolved recursively, so `full` never repeats what `intermediate` already lists.
 */
export const LEVELS = Object.freeze({
  intermediate: {
    extends: null,
    adds: ctx => [{
      path: cacheDirOf(ctx.stateRoot),
      category: 'evidence cache',
      why: 'L2 verification evidence; rebuilt on the next run that needs it',
    }],
  },
  full: {
    extends: 'intermediate',
    adds: ctx => [{
      path: join(coordinationWorkspace(ctx.workspace), '.pair-work'),
      category: 'driver worktrees',
      why: 'isolated checkouts for the dual-Driver workflow; recreated at pair_start',
    }],
  },
});

/** Resolve a level to its entry list. Exported because 'levels are strategies' is a claim. */
export function resolveEntries(ctx, level, levels = LEVELS) {
  const spec = levels[level];
  if (spec === undefined) throw new Error('pair_cleanup level must be one of: ' + Object.keys(levels).join(', '));
  const base = spec.extends === null ? [] : resolveEntries(ctx, spec.extends, levels);
  return [...base, ...spec.adds(ctx)];
}

/** The durable record, listed so a plan answers "what stays" as well as "what goes". */
export function keptRecords(teamIds) {
  const kept = [
    { path: 'lessons.json', why: 'process lessons carried into the next session' },
    { path: 'retired-members.json', why: 'deny-list that keeps retired seats retired' },
    { path: '.pair-oracles/ (frozen acceptance oracles)', why: 'the evidence a completion was judged on' },
    { path: '<team>/inbox/*.jsonl', why: 'the at-least-once delivery record' },
  ];
  for (const id of teamIds) {
    kept.push({ path: id + '/team.json', why: 'the board the console reads' });
    kept.push({ path: id + '/retro.md', why: 'retrospective' });
    kept.push({ path: id + '/decisions.md', why: 'arbitration log' });
  }
  return kept;
}

function sizeOf(path) {
  if (!existsSync(path)) return { bytes: 0, files: 0 };
  const stats = statSync(path);
  if (stats.isFile()) return { bytes: stats.size, files: 1 };
  let bytes = 0, files = 0;
  for (const entry of readdirSync(path)) {
    const child = sizeOf(join(path, entry));
    bytes += child.bytes; files += child.files;
  }
  return { bytes, files };
}

/** The digest that binds a reviewed plan to the tree it was reviewed against. */
const tokenOf = (level, present) => createHash('sha256')
  .update(level + String.fromCharCode(10) + present.map(entry => entry.path + '|' + entry.bytes).sort().join(String.fromCharCode(10)))
  .digest('hex');

/** Preconditions, checked once before either transition. */
async function assertCleanable(stateRoot, team, agent) {
  if (!isCaptain(team, agent)) throw new Error('only the Captain may clean up its own workspace');
  const live = [];
  for (const id of await listTeamDirs(stateRoot)) {
    const board = await readTeam(stateRoot, id);
    if (board !== undefined && !isDispatchClosed(board.protocol.phase)) live.push(id + ' (' + board.protocol.phase + ')');
  }
  if (live.length > 0) {
    throw new Error('pair_cleanup refuses while a team is live: ' + live.join(', ') + ' - finish or abandon it first, because these paths are what an in-flight run relies on');
  }
}

/** The plan state: the only thing `execute` accepts. */
async function planState(ctx, level) {
  const present = resolveEntries(ctx, level)
    .map(entry => ({ ...entry, ...sizeOf(entry.path) }))
    .filter(entry => entry.bytes > 0 || existsSync(entry.path));
  return { level, present, token: tokenOf(level, present), bytes: present.reduce((sum, entry) => sum + entry.bytes, 0) };
}

export function registerCleanupTools(ctx, config, runtime = {}) {
  ctx.tools.register(defineTool({
    name: 'pair_cleanup',
    description: 'Captain only: reclaim the disk space THIS pair run made. action="plan" (default) lists exactly what would be removed and what is kept, with sizes and reasons, and changes nothing; action="execute" needs the token from that plan and refuses if the tree moved since. level="intermediate" removes regenerable caches, level="full" also removes driver worktrees. Boards, arbitration logs, retrospectives, lessons, the retired-member deny-list, mailbox records and the frozen oracles are KEPT at both levels - if you truly want the space back, delete those folders yourself rather than asking a tool to guess.',
    parameters: {
      action: { type: 'string', description: 'plan (default) | execute' },
      level: { type: 'string', description: 'intermediate (default) | full' },
      token: { type: 'string', description: 'Required with action="execute": the token the plan returned.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: value.summary }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const team = await requireParticipantTeam(agent, config);
      const context = { workspace: workspaceOf(agent), stateRoot: stateRootFor(agent, config) };
      const action = args.action === undefined ? 'plan' : String(args.action);
      const level = args.level === undefined ? 'intermediate' : String(args.level);
      if (!['plan', 'execute'].includes(action)) throw new Error('pair_cleanup action must be plan or execute');
      await assertCleanable(context.stateRoot, team, agent);
      const plan = await planState(context, level);
      const records = keptRecords(await listTeamDirs(context.stateRoot));
      const described = plan.present.map(entry => entry.path + ' [' + entry.category + ']').join('; ');
      if (action === 'plan') {
        return { action, level, token: plan.token, targets: plan.present, kept: records, bytes: plan.bytes,
          summary: 'pair_cleanup PLAN (' + level + '): ' + plan.present.length + ' path(s), ' + plan.bytes + ' bytes would be removed - '
            + (described === '' ? 'nothing to remove' : described)
            + '. KEPT: ' + records.length + ' record path(s) (boards, logs, retro, lessons, deny-list, mailboxes, frozen oracles). Nothing was changed. Re-run with action="execute", token="' + plan.token + '".' };
      }
      if (args.token === undefined || String(args.token) !== plan.token) {
        throw new Error('pair_cleanup refuses: the token does not match the current tree. Run action="plan" again and pass back what it returns - this is the fallback that keeps a wrong identification from deleting anything.');
      }
      const removed = [], failed = [];
      for (const entry of plan.present) {
        try { await rm(entry.path, { recursive: true, force: true }); removed.push(entry); }
        catch (error) { failed.push({ path: entry.path, reason: String(error.message) }); }
      }
      const remaining = resolveEntries(context, level).map(entry => ({ path: entry.path, ...sizeOf(entry.path) })).filter(entry => entry.bytes > 0);
      return { action, level, removed, failed, remaining, bytes: plan.bytes,
        summary: 'pair_cleanup EXECUTED (' + level + '): removed ' + removed.length + ' path(s), ' + plan.bytes + ' bytes'
          + (failed.length === 0 ? '' : '; FAILED: ' + failed.map(item => item.path + ' (' + item.reason + ')').join(', '))
          + (remaining.length === 0 ? '; nothing regenerable remains' : '; still present: ' + remaining.map(entry => entry.path).join(', '))
          + '. Records kept: boards, logs, retro, lessons, deny-list, mailboxes, frozen oracles. For the space truly back, delete the remaining folders yourself - this tool will not guess at things it did not write.' };
    },
  }));
}