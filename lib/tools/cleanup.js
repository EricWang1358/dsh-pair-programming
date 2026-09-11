/**
 * pair_cleanup: the Captain reclaims the space THIS pair run made, in two phases.
 *
 * The problem it exists for: the plugin's own working state accumulates (driver worktrees,
 * the evidence cache), and the only remedy was deleting directories by hand - which, when the
 * identification is wrong, has no fallback at all. So the destructive act becomes reviewable:
 * a PLAN lists exactly what would go and what stays, with sizes and reasons; EXECUTION needs
 * the plan's token, and a tree that moved since the plan refuses and asks for a new one.
 *
 * Three guards, each from a scar of this project:
 *  - a live team refuses both phases - deleting the worktrees an open cycle depends on breaks
 *    a run that is still in flight;
 *  - only the calling session's own workspace is touched (pair_* resolves the workspace from
 *    the caller's cwd), never another workspace;
 *  - only paths this plugin writes are ever listed, by exact name from the layout module - no
 *    globs, so a file the plugin did not create cannot be matched by accident.
 *
 * What BOTH levels keep is deliberate: boards (team.json, incl. archived teams), the
 * arbitration log, the retrospective, the process lessons, the retired-member deny-list and
 * the frozen oracles. Those are the run's record and its acceptance evidence; "full" means
 * everything REGENERABLE, not everything. A user who wants the space truly back should delete
 * the folders themselves, and the tool says so instead of doing it for them.
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

const LEVELS = ['intermediate', 'full'];
const sha = text => createHash('sha256').update(text).digest('hex');

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

/** Every path this plugin writes that is not part of the durable record. */
function clearablePaths(stateRoot, workspace, level) {
  const paths = [{
    path: cacheDirOf(stateRoot),
    category: 'evidence cache',
    why: 'L2 verification evidence; rebuilt on the next run that needs it',
  }];
  if (level === 'full') {
    paths.push({
      path: join(coordinationWorkspace(workspace), '.pair-work'),
      category: 'driver worktrees',
      why: 'isolated checkouts for the dual-Driver workflow; recreated at pair_start',
    });
  }
  return paths;
}

/** The durable record, listed so the plan answers "what stays" as well as "what goes". */
function keptRecords(stateRoot, teamIds) {
  const kept = [
    { path: 'lessons.json', why: 'process lessons carried into the next session' },
    { path: 'retired-members.json', why: 'deny-list that keeps retired seats retired' },
    { path: '.pair-oracles/ (frozen acceptance oracles)', why: 'the evidence a completion was judged on' },
  ];
  for (const id of teamIds) {
    kept.push({ path: id + '/team.json', why: 'the board the console reads' });
    kept.push({ path: id + '/retro.md', why: 'retrospective' });
    kept.push({ path: id + '/decisions.md', why: 'arbitration log' });
  }
  return kept;
}

export function registerCleanupTools(ctx, config, runtime = {}) {
  ctx.tools.register(defineTool({
    name: 'pair_cleanup',
    description: 'Captain only: reclaim the disk space THIS pair run made. action="plan" (default) lists exactly what would be removed and what is kept, with sizes and reasons, and changes nothing; action="execute" needs the token from that plan and refuses if the tree moved since. level="intermediate" removes regenerable caches, level="full" also removes driver worktrees. Boards, arbitration logs, retrospectives, lessons, the retired-member deny-list and the frozen oracles are KEPT at both levels - if you truly want the space back, delete those folders yourself rather than asking a tool to guess.',
    parameters: {
      action: { type: 'string', description: 'plan (default) | execute' },
      level: { type: 'string', description: 'intermediate (default) | full' },
      token: { type: 'string', description: 'Required with action="execute": the token the plan returned.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const team = await requireParticipantTeam(agent, config);
      const workspace = workspaceOf(agent);
      const stateRoot = stateRootFor(agent, config);
      const action = args.action === undefined ? 'plan' : String(args.action);
      const level = args.level === undefined ? 'intermediate' : String(args.level);
      if (!['plan', 'execute'].includes(action)) throw new Error('pair_cleanup action must be plan or execute');
      if (!LEVELS.includes(level)) throw new Error('pair_cleanup level must be intermediate or full');
      if (!isCaptain(team, agent)) throw new Error('only the Captain may clean up its own workspace');
      // Guard: a live team refuses both phases.
      const dirs = await listTeamDirs(stateRoot);
      const live = [];
      for (const id of dirs) {
        const board = await readTeam(stateRoot, id);
        if (board !== undefined && !isDispatchClosed(board.protocol.phase)) live.push(id + ' (' + board.protocol.phase + ')');
      }
      if (live.length > 0) {
        throw new Error('pair_cleanup refuses while a team is live: ' + live.join(', ') + ' - finish or abandon it first, because these paths are what an in-flight run relies on');
      }
      const targets = clearablePaths(stateRoot, workspace, level);
      const present = targets.map(entry => ({ ...entry, ...sizeOf(entry.path) })).filter(entry => entry.bytes > 0 || existsSync(entry.path));
      const manifest = present.map(entry => entry.path + '|' + entry.bytes).sort().join(String.fromCharCode(10));
      const token = sha(level + String.fromCharCode(10) + manifest);
      const records = keptRecords(stateRoot, dirs);
      const bytes = present.reduce((sum, entry) => sum + entry.bytes, 0);
      if (action === 'plan') {
        return { action, level, token, targets: present, kept: records, bytes,
          summary: 'pair_cleanup PLAN (' + level + '): ' + present.length + ' path(s), ' + bytes + ' bytes would be removed - '
            + present.map(entry => entry.path + ' [' + entry.category + ']').join('; ')
            + (present.length === 0 ? 'nothing to remove' : '')
            + '. KEPT: ' + records.length + ' record path(s) (boards, logs, retro, lessons, deny-list, frozen oracles). Nothing was changed. Re-run with action="execute", token="' + token + '".' };
      }
      if (args.token === undefined || String(args.token) !== token) {
        throw new Error('pair_cleanup refuses: the token does not match the current tree. Run action="plan" again and pass back what it returns - this is the fallback that keeps a wrong identification from deleting anything.');
      }
      const removed = [];
      for (const entry of present) { await rm(entry.path, { recursive: true, force: true }); removed.push(entry); }
      const after = targets.map(entry => ({ ...entry, ...sizeOf(entry.path) }));
      const remaining = after.filter(entry => entry.bytes > 0);
      return { action, level, removed, remaining, bytes,
        summary: 'pair_cleanup EXECUTED (' + level + '): removed ' + removed.length + ' path(s), ' + bytes + ' bytes'
          + (remaining.length === 0 ? '; nothing regenerable remains' : '; still present: ' + remaining.map(entry => entry.path).join(', '))
          + '. Records kept: boards, logs, retro, lessons, deny-list, frozen oracles. For the space truly back, delete the remaining folders yourself - this tool will not guess at things it did not write.' };
    },
  }));
}