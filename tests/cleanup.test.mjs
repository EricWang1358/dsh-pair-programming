/** pair_cleanup: the plan changes nothing, the guards refuse, the records survive. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCleanupTools, resolveEntries, LEVELS, keptRecords } from '../lib/tools/cleanup.js';
import { initialProtocolState } from '../lib/protocol/machine.js';
import { createTeamDir } from '../lib/state/store.js';
import { coordinationWorkspace } from '../lib/runtime/workspace-context.js';

async function fingerprint(root) {
  const hash = createHash('sha256');
  const walk = async (dir, prefix = '') => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = prefix + '/' + entry.name;
      if (entry.isDirectory()) { hash.update(rel + '/'); await walk(join(dir, entry.name), rel); }
      else hash.update(rel + ':' + (await readFile(join(dir, entry.name))).length);
    }
  };
  await walk(root);
  return hash.digest('hex');
}

async function harness(phase) {
  const workspace = await mkdtemp(join(tmpdir(), 'pair-cleanup-'));
  const config = { stateDir: '.pair-programming' };
  const stateRoot = join(workspace, config.stateDir);
  const team = { id: 'clean', name: 'clean', goal: 'g', mode: 'light', tddMode: 'enforce', captainSessionId: 'cap',
    members: [{ id: 'd', name: 'driver', role: 'driver', status: 'idle', joinedAt: 1 }], tasks: [], taskSeq: 0,
    createdAt: 1, updatedAt: 1, protocol: { ...initialProtocolState(), phase } };
  await createTeamDir(stateRoot, team);
  await mkdir(join(stateRoot, 'cache'), { recursive: true });
  await writeFile(join(stateRoot, 'cache', 'entry.json'), 'x'.repeat(64));
  await writeFile(join(stateRoot, 'clean', 'retro.md'), 'retro');
  const workRoot = join(coordinationWorkspace(workspace), '.pair-work');
  await mkdir(join(workRoot, 'slot'), { recursive: true });
  await writeFile(join(workRoot, 'slot', 'checkout.txt'), 'y'.repeat(32));
  const defs = new Map();
  const ctx = { tools: { register: tool => defs.set(tool.name, tool) }, logger: { warn() {}, debug() {} } };
  registerCleanupTools(ctx, config, {});
  const agent = { id: 'cap', session: { header: { cwd: workspace }, append() {} } };
  const call = args => defs.get('pair_cleanup').execute(args, { agent });
  return { workspace, stateRoot, workRoot, call, cleanup: () => rm(workspace, { recursive: true, force: true }),
    cleanupWork: () => rm(workRoot, { recursive: true, force: true }) };
}

export async function run(check) {
  /* ---- shapes: levels are strategies, and the operation is a guarded transition ---- */
  const stratCtx = { stateRoot: 'S', workspace: 'W' };
  const strategyLevels = {
    ...LEVELS,
    // A level invented HERE, with the same resolver shape. If the executor had to know its name,
    // this assertion could not be written - which is the property being pinned.
    deep: { extends: 'full', adds: () => [{ path: 'S/extra', category: 'test strategy', why: 'invented for this assertion' }] },
  };
  const intermediate = resolveEntries(stratCtx, 'intermediate').map(entry => entry.path);
  const full = resolveEntries(stratCtx, 'full').map(entry => entry.path);
  const deep = resolveEntries(stratCtx, 'deep', strategyLevels).map(entry => entry.path);
  check(full.length === intermediate.length + 1 && intermediate.every(p => full.includes(p)),
    'a level composes over its base instead of restating it (full = intermediate + worktrees)');
  check(deep.length === full.length + 1 && deep.includes('S/extra'),
    'a NEW level resolves through the same table with no change to the executor - levels are strategies, not branches');
  check(keptRecords([]).length === 4 && keptRecords(['t-1']).some(k => k.path === 't-1/team.json'),
    'the kept-record list always carries the four workspace-wide records and derives the per-team ones');
  let unknown = '';
  try { resolveEntries(stratCtx, 'nonsense'); } catch (error) { unknown = String(error.message); }
  check(unknown.includes('level must be one of'), 'an unknown level is refused by the table, not silently treated as intermediate');
  const h = await harness('DONE');
  try {
    const before = await fingerprint(h.stateRoot);
    const plan = await h.call({ action: 'plan', level: 'intermediate' });
    check(await fingerprint(h.stateRoot) === before, 'a plan changes not one byte');
    check(plan.targets.some(t => t.category === 'evidence cache'), 'the plan names the evidence cache');
    check(!plan.targets.some(t => t.category === 'driver worktrees'), 'the intermediate level does not touch driver worktrees');
    check(plan.kept.some(k => k.path === 'clean/team.json') && plan.kept.some(k => k.path === 'clean/retro.md'),
      'the plan names the records it will keep, not only what it will delete');
    const full = await h.call({ action: 'plan', level: 'full' });
    check(full.bytes > plan.bytes, 'the full level accounts for more bytes than the intermediate one');
    let refused = '';
    try { await h.call({ action: 'execute', level: 'intermediate', token: 'wrong' }); } catch (error) { refused = String(error.message); }
    check(refused.includes('token does not match'), 'a token that does not match the tree is refused');
    check(await fingerprint(h.stateRoot) === before, 'and the refusal deleted nothing');
    const done = await h.call({ action: 'execute', level: 'intermediate', token: plan.token });
    check(done.removed.length === 1 && done.bytes > 0, 'executing the plan removes exactly what it listed');
    check(!existsSync(join(h.stateRoot, 'cache')), 'the evidence cache is gone');
    check(existsSync(join(h.stateRoot, 'clean', 'team.json')) && existsSync(join(h.stateRoot, 'clean', 'retro.md')),
      'the board and the retrospective survive - full means regenerable, not everything');
    // Re-plan first: the previous token was bound to a tree that still had the cache, and the
    // tool refusing it is the guard working, not a bug (my first version of this test passed a stale token).
    const replan = await h.call({ action: 'plan', level: 'intermediate' });
    const again = await h.call({ action: 'execute', level: 'intermediate', token: replan.token });
    check(again.removed.length === 0, 'a second run of the same level is empty, not an error (idempotent)');
  } finally { await h.cleanup(); await h.cleanupWork(); }
  const live = await harness('CYCLING');
  try {
    let message = '';
    try { await live.call({ action: 'plan' }); } catch (error) { message = String(error.message); }
    check(message.includes('refuses while a team is live'), 'a live team refuses the plan - those paths are what an in-flight run relies on');
  } finally { await live.cleanup(); await live.cleanupWork(); }
}