/** pair_start output must survive the host lossless-JSON gate (PTC bridge) in both lessons states. */
import { isJsonValue } from '@deepseek-ai/dsh-util-values';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerLifecycleTools } from '../lib/tools/lifecycle.js';
import { lessonsFileOf } from '../lib/state/layout.js';
import { readTeam, writeTeam } from '../lib/state/store.js';
const USE_CASES = [{ actor: 'maintainer', intent: 'exercise lifecycle', outcome: 'observe correct state', acceptance_criteria: ['lifecycle call succeeds'] }];

/** startHarness from lifecycle.test.mjs minus failure injection: pair_start must succeed here. */
function startHarness(root, stateDir, config = {}) {
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
  registerLifecycleTools(ctx, { stateDir, memberProvider: 'pair', tddMode: 'enforce', pairStyle: 'traditional', defaultMode: 'full', greenBuildOnStop: false, ...config }, { selections: { withPending: async (i, l, s, op) => op() }, scheduler: {} });
  const captain = { id: 'cap1', session: { header: { cwd: root }, append: () => {}, requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } };
  return { spawns, start: defs.find((d) => d.name === 'pair_start').execute, stop: defs.find((d) => d.name === 'pair_stop').execute, status: defs.find((d) => d.name === 'pair_status').execute, captain };
}

export async function run(check) {
  const root = await mkdtemp(join(tmpdir(), 'pair-out-'));
  try {
    // Runtime settings must affect the ordinary omitted-mode call; otherwise
    // the advertised light fast lane is unreachable without prompt surgery.
    const configuredLight = startHarness(root, 'out-default-light', { defaultMode: 'light' });
    const lightByDefault = await configuredLight.start({ goal: 'g', name: 'configured-light', use_cases: USE_CASES }, { agent: configuredLight.captain });
    check(lightByDefault.mode === 'light' && configuredLight.spawns.length === 2, 'configured defaultMode=light is honored when pair_start omits mode');

    const explicitFull = startHarness(root, 'out-explicit-full', { defaultMode: 'light' });
    const fullOverride = await explicitFull.start({ goal: 'g', mode: 'full', name: 'explicit-full', use_cases: USE_CASES }, { agent: explicitFull.captain });
    check(fullOverride.mode === 'full' && explicitFull.spawns.length === 3, 'explicit mode=full overrides configured defaultMode=light');

    // State A: no lessons.json — the host bridge must accept the whole return value.
    const a = startHarness(root, 'out-a');
    const okA = await a.start({ goal: 'g', mode: 'light', name: 'lo-a', use_cases: USE_CASES }, { agent: a.captain });
    check(okA.team_id === 'lo-a' && a.spawns.length === 2, 'state A: pair_start succeeds with 2 spawns and the right team id');
    check(isJsonValue(okA) === true, 'state A: no lessons.json — output passes the lossless-JSON gate (no undefined carried_lessons)');

    // C3 (#18): the status projection must print the two contracts a team is
    // judged by, from the modules that decide them — the effective write scope
    // (protocol/scope.js, the one allowed-write-set shared by proposal, guard and
    // integration) and the oracle's declared exit-code mapping. Both were
    // previously reconstructible only by reading the plugin source, and the
    // three-layer scope divergence was measured (B3).
    const c3Board = await readTeam(join(root, 'out-a'), okA.team_id);
    c3Board.tasks.push({
      id: 't-c3', subject: 'status projection', status: 'pending', dependencies: [], createdAt: 1, updatedAt: 2,
      scope: { declared: true, writes: ['src', 'docs'], reads: [], resources: [] },
      oracle: { files: ['.pair-oracles/t-c3/a.mjs'], cmd: 'node .pair-oracles/t-c3/a.mjs', sha: 'x', redExit: 1, divergences: ['a hidden test could read the second sentence instead of the first'], instrumentExitCodes: [2], caseRefs: ['UC-1.AC-1'] },
    });
    await writeTeam(join(root, 'out-a'), c3Board);
    const c3 = await a.status({}, { agent: a.captain });
    const c3Row = (c3.effective_scope ?? []).find(row => row.task_id === 't-c3');
    check(c3Row?.source === 'scope.writes' && c3Row.writes.includes('src') && c3Row.writes.includes('.pair-oracles/t-c3/a.mjs'),
      'C3: effective_scope comes from the shared allowed-write-set (declared envelope + sealed oracle artifacts)');
    check(c3.oracle_exit_semantics?.[0]?.exit_semantics?.['2']?.startsWith('instrument') === true
      && c3.oracle_exit_semantics[0].exit_semantics['0'] === 'success',
      'C3: the oracle exit-code contract is printed rather than reconstructed (2 = instrument, 0 = success)');
    check(Array.isArray(c3.yielded_obligations) && c3.yielded_obligations.length === 0
      && (c3.blocking_cause === null || typeof c3.blocking_cause?.suggested_action === 'string'),
      'C3: yielded obligations are an explicit list and blocking_cause is either a named cause or an explicit null, never undefined');
    check(c3.summary.includes('Effective scope (what may be written') && c3.summary.includes('Blocking cause:'),
      'C3: both projections also reach the summary a captain actually reads');
    check(isJsonValue(c3), 'C3: the enriched status still passes the lossless-JSON validator');

    // The planning budget counts DISPUTES. A ruling that only discharged a
    // declared disclosure is the board's own paperwork: charging it would let the
    // board block the filing it demands (measured: five refusals of
    // "used 2 of 2 planning arbitrations").
    const { planningArbitrationsUsed } = await import('../lib/protocol/machine.js');
    const budgetBoard = { cycles: [], decisions: [
      { id: 'd-dispute', taskId: 't-1', rationale: 'r', at: 1 },
      { id: 'd-book', taskId: 't-1', closesDisclosure: 'oracle:t-1:seal:non-gating', disposition: 'fixed', billing: 'bookkeeping', at: 2 },
      { id: 'd-both', taskId: 't-1', closesDisclosure: 'oracle:t-1:seal:non-gating', disposition: 'fixed', billing: 'dispute', at: 3 },
    ] };
    const used = planningArbitrationsUsed(budgetBoard, 't-1');
    check(used.count === 2 && used.decided.includes('d-dispute') && used.decided.includes('d-both') && !used.decided.includes('d-book'),
      'a bookkeeping ruling is not charged to the task whose gap it closed, while a ruling that is also a dispute still is');
    check(planningArbitrationsUsed({ cycles: [], decisions: [{ ...budgetBoard.decisions[1], billing: undefined }] }, 't-1').count === 1,
      'and a ruling that cannot say what it is stays counted: a silent record is not assumed free');

    const fixedBoard = await readTeam(join(root, 'out-a'), okA.team_id);
    fixedBoard.protocol.decisions.push({ id:'fixed-example', disposition:'fixed', closesDisclosure:'d-1' });
    await writeTeam(join(root,'out-a'),fixedBoard);
    const fixedStatus = await a.status({}, {agent:a.captain});
    check(isJsonValue(fixedStatus), 'pair_status with fixed ruling passes actual DSH lossless JSON validator');
    check(fixedStatus.residual_ledger[0].sink===null && fixedStatus.residual_ledger[0].at===null, 'fixed ruling missing sink/time fields are explicit nulls');
    fixedBoard.tasks.push({id:'completed',subject:'finished',status:'completed',dependencies:[],createdAt:1,updatedAt:2});
    fixedBoard.protocol.phase='RETRO';
    await writeTeam(join(root,'out-a'),fixedBoard);
    const recovery=await a.status({}, {agent:a.captain});
    check(isJsonValue(recovery) && recovery.recovery_actions[0]?.tool==='pair_gate_check', 'RETRO status gives Captain lossless re-certification actions without a bypass');


    // State A2 (M13' regression): pair_stop keeps the archived dir for audit, so
    // findTeamByCaptain must skip DONE teams — the same captain session can then
    // start a NEW team (fail-closed: unreadable/malformed records still block).
    const stopped = await a.stop({ outcome: 'aborted', reason: 'm13 regression' }, { agent: a.captain });
    check(stopped.team_id === 'lo-a' && typeof stopped.retired === 'number', 'state A2: pair_stop closes the team and reports its retirements');
    let restarted;
    let restartError;
    try {
      restarted = await a.start({ goal: 'g2', mode: 'light', name: 'lo-a2', use_cases: USE_CASES }, { agent: a.captain });
    } catch (error) {
      restartError = error;
    }
    check(restarted?.team_id === 'lo-a2' && a.spawns.length === 4, 'state A2: after pair_stop the same captain session starts a new team (2 more spawns)');
    check(restartError === undefined, `state A2: no "you already lead" after stop${restartError ? ` — got: ${restartError.message}` : ''}`);
    check(isJsonValue(restarted) === true, 'state A2: second pair_start output also passes the lossless-JSON gate');

    // State A3 (M13' round 2, prefer-active ruling): with a DONE archive (lo-a) and
    // a live team (lo-a2) coexisting, the captain seat resolves pair_status/pair_stop
    // to the LIVE team; with no live team left, pair_status falls back to the first
    // DONE archive (tool-level audit face). Fail-closed: unreadable/malformed still block.
    let st1;
    let st1Error;
    try {
      st1 = await a.status({}, { agent: a.captain });
    } catch (error) {
      st1Error = error;
    }
    check(st1 !== undefined && st1.summary.includes('Team "lo-a2"'), 'state A3: pair_status resolves to the live team lo-a2 while lo-a is archived');
    check(st1Error === undefined, `state A3: no "belongs to multiple active teams" while a DONE archive coexists${st1Error ? ` — got: ${st1Error.message}` : ''}`);
    let stopped2;
    let stop2Error;
    try {
      stopped2 = await a.stop({ outcome: 'aborted', reason: 'm13 round2' }, { agent: a.captain });
    } catch (error) {
      stop2Error = error;
    }
    check(stopped2?.team_id === 'lo-a2', `state A3: pair_stop resolves the live team while an archive coexists${stop2Error ? ` — got: ${stop2Error.message}` : ''}`);
    let st3;
    let st3Error;
    try {
      st3 = await a.status({}, { agent: a.captain });
    } catch (error) {
      st3Error = error;
    }
    check(st3?.blocking_cause === null && Array.isArray(st3?.yielded_obligations) && st3.yielded_obligations.length === 0,
      'C3: on a terminal board nothing is owed, so blocking_cause is an explicit null rather than an absent key');
    check(st3 !== undefined && st3.phase === 'ABORTED' && st3.summary.includes('Team "lo-a" ('), `state A3: after stopping lo-a2, pair_status falls back to the first terminal archive (lo-a, ABORTED phase — tool-level audit face)${st3Error ? ` — got: ${st3Error.message}` : ''}`);
    // State B: lessons.json present — same gate, and only the keep/try projection is carried.
    const b = startHarness(root, 'out-b');
    await mkdir(join(root, 'out-b'), { recursive: true });
    await writeFile(lessonsFileOf(join(root, 'out-b')), JSON.stringify({ teamId: 't-prev', keep: ['k-1'], try: ['t-1'] }), 'utf8');
    const okB = await b.start({ goal: 'g', mode: 'light', name: 'lo-b', use_cases: USE_CASES, inherit_lessons:true }, { agent: b.captain });
    check(isJsonValue(okB) === true, 'state B: with lessons.json — output passes the lossless-JSON gate');
    check(JSON.stringify(okB.carried_lessons) === '{"keep":["k-1"],"try":["t-1"]}', 'state B: carried_lessons is exactly the keep/try projection (teamId excluded)');
    const fresh = startHarness(root, 'out-fresh');
    await mkdir(join(root, 'out-fresh'), {recursive:true});
    await writeFile(lessonsFileOf(join(root, 'out-fresh')), JSON.stringify({keep:['unrelated project'],try:[]}), 'utf8');
    const freshResult=await fresh.start({goal:'different project',name:'fresh',use_cases:USE_CASES},{agent:fresh.captain});
    check(freshResult.carried_lessons===null,'new project does not silently inherit workspace lessons');
    check(freshResult.artifact_root!==okB.artifact_root,'new runs have distinct artifact roots even with identical task numbering');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return { sharedRoot: root, stateRootA: join(root, 'out-a'), stateRootB: join(root, 'out-b') };
}
