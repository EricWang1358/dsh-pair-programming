/** pair_start output must survive the host lossless-JSON gate (PTC bridge) in both lessons states. */
import { isJsonValue } from '@deepseek-ai/dsh-util-values';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerLifecycleTools } from '../lib/tools/lifecycle.js';
import { lessonsFileOf } from '../lib/state/layout.js';

/** startHarness from lifecycle.test.mjs minus failure injection: pair_start must succeed here. */
function startHarness(root, stateDir) {
  const spawns = []; const defs = [];
  const schemas = ['read', 'write', 'edit', 'pair_start', 'pair_stop', 'pair_rotate', 'pair_arbitrate'].map((name) => ({ name }));
  const ctx = {
    logger: { warn: () => {}, debug: () => {}, error: () => {} },
    tools: { register: (d) => { defs.push(d); }, schemas: () => schemas },
    agents: { get: () => undefined },
    llm: { resolveCallConfig: async (c) => c },
    subagents: {
      interrupt: () => {}, list: () => ['pair'],
      getProvider: () => ({ prepareContinuable: () => {}, capabilities: { persona: true, toolFilter: true } }),
      startContinuable: async ({ label }) => { spawns.push(label); return { childId: 'child-' + spawns.length }; },
    },
  };
  registerLifecycleTools(ctx, { stateDir, memberProvider: 'pair', tddMode: 'enforce', pairStyle: 'traditional', greenBuildOnStop: false }, { selections: { withPending: async (i, l, s, op) => op() }, scheduler: {} });
  const captain = { id: 'cap1', session: { header: { cwd: root }, append: () => {}, requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } };
  return { spawns, start: defs.find((d) => d.name === 'pair_start').execute, stop: defs.find((d) => d.name === 'pair_stop').execute, captain };
}

export async function run(check) {
  const root = await mkdtemp(join(tmpdir(), 'pair-out-'));
  try {
    // State A: no lessons.json — the host bridge must accept the whole return value.
    const a = startHarness(root, 'out-a');
    const okA = await a.start({ goal: 'g', mode: 'light', name: 'lo-a' }, { agent: a.captain });
    check(okA.team_id === 'lo-a' && a.spawns.length === 2, 'state A: pair_start succeeds with 2 spawns and the right team id');
    check(isJsonValue(okA) === true, 'state A: no lessons.json — output passes the lossless-JSON gate (no undefined carried_lessons)');

    // State A2 (M13' regression): pair_stop keeps the archived dir for audit, so
    // findTeamByCaptain must skip DONE teams — the same captain session can then
    // start a NEW team (fail-closed: unreadable/malformed records still block).
    const stopped = await a.stop({ reason: 'm13 regression' }, { agent: a.captain });
    check(stopped.team_id === 'lo-a' && typeof stopped.retired === 'number', 'state A2: pair_stop closes the team and reports its retirements');
    let restarted;
    let restartError;
    try {
      restarted = await a.start({ goal: 'g2', mode: 'light', name: 'lo-a2' }, { agent: a.captain });
    } catch (error) {
      restartError = error;
    }
    check(restarted?.team_id === 'lo-a2' && a.spawns.length === 4, 'state A2: after pair_stop the same captain session starts a new team (2 more spawns)');
    check(restartError === undefined, `state A2: no "you already lead" after stop${restartError ? ` — got: ${restartError.message}` : ''}`);
    check(isJsonValue(restarted) === true, 'state A2: second pair_start output also passes the lossless-JSON gate');
    // State B: lessons.json present — same gate, and only the keep/try projection is carried.
    const b = startHarness(root, 'out-b');
    await mkdir(join(root, 'out-b'), { recursive: true });
    await writeFile(lessonsFileOf(join(root, 'out-b')), JSON.stringify({ teamId: 't-prev', keep: ['k-1'], try: ['t-1'] }), 'utf8');
    const okB = await b.start({ goal: 'g', mode: 'light', name: 'lo-b' }, { agent: b.captain });
    check(isJsonValue(okB) === true, 'state B: with lessons.json — output passes the lossless-JSON gate');
    check(JSON.stringify(okB.carried_lessons) === '{"keep":["k-1"],"try":["t-1"]}', 'state B: carried_lessons is exactly the keep/try projection (teamId excluded)');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return { sharedRoot: root, stateRootA: join(root, 'out-a'), stateRootB: join(root, 'out-b') };
}
