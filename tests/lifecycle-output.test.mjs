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
  check(st1.summary.includes('Loads'), 'the board line carries the CE load ledger, so a credential refusal is never unexplained (wiring, not just rendering)');
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
    // ---- U2: the board is a surface, and the acceptance author must not read the
    // candidate through it. The seat keeps its four tools; pair_status was the one that
    // still answered with the raw board (proposal files, RED test files, GREEN evidence,
    // the Driver's tuned-to-the-instrument declaration, and every other card's seal).
    const solo = startHarness(root, 'out-expose');
    await solo.start({ goal: 'exposure probe', mode: 'solo', name: 'expose', use_cases: USE_CASES }, { agent: solo.captain });
    const exposeBoard = await readTeam(join(root, 'out-expose'), 'expose');
    const specSeat = exposeBoard.members.find(m => m.role === 'spec');
    check(specSeat !== undefined && specSeat.id !== '', 'U2 the solo run has a SPEC seat to ask as');
    exposeBoard.tasks.push({
      id: 't-1', subject: 'the contract stays visible', status: 'in_progress', assignee: 'driver', attemptId: 'a-1',
      dependencies: [], createdAt: 1, updatedAt: 2, acceptanceRefs: [],
      oracle: { sha: 'a'.repeat(64), files: ['.pair-oracles/ns/t-1/accept.mjs'], cmd: 'node .pair-oracles/ns/t-1/accept.mjs', caseRefs: [], divergences: [] },
    });
    exposeBoard.tasks.push({ id: 't-2', subject: 'another card', status: 'pending', dependencies: [], createdAt: 1, updatedAt: 2,
      oracle: { sha: 'b'.repeat(64), files: ['.pair-oracles/ns/t-2/accept.mjs'], cmd: 'node .pair-oracles/ns/t-2/accept.mjs', caseRefs: [], divergences: [] } });
    exposeBoard.protocol.cycles.push({ id: 'c-1', taskId: 't-1', step: 'GREEN', openedAt: 1,
      proposal: { files: ['src/secret-approach.mjs'] }, red: { testFiles: ['t.mjs'] },
      green: { evidence: ['suite green'], tunedForOracle: 'the counter was fitted to the acceptance run' },
      report: { diffSummary: 'src/secret-approach.mjs +40/-2' },
      pushbacks: [{ kind: 'reject', stage: 'final', category: 'quality', observation: 'the counter is fitted to the acceptance run, not to the contract', at: 3 }],
      corrections: [{ at: 4, by: 'navigator', field: 'report.test_results', correction: 'CANDIDATE-CORRECTION', evidence: ['x'] }] });
    await writeTeam(join(root, 'out-expose'), exposeBoard);
    const asSpec = await solo.status({}, { agent: { id: specSeat.id, session: { header: { cwd: root }, append() {} } } });
    const specCycle = asSpec.cycles.find(c => c.id === 'c-1');
    const specOther = asSpec.tasks.find(t => t.id === 't-2');
    check(specCycle.proposal === undefined && specCycle.green === undefined && specCycle.report === undefined && specCycle.red === undefined,
      'U2 the acceptance author does not read the candidate through the board: no proposal, RED, GREEN or report on any cycle');
    check(specCycle.step === 'GREEN' && specCycle.taskId === 't-1', 'U2 while the cycle still says where the work stands (step and task survive the projection)');
    check(specCycle.pushbacks === undefined, 'U2 the appended pushback record quotes the candidate too, so it stays off the acceptance seat');
    check(specCycle.corrections === undefined && !JSON.stringify(asSpec).includes('CANDIDATE-CORRECTION'),
            'U2 and so does an appended correction: it describes the candidate record');
    check(specOther.oracle !== undefined && specOther.oracle.frozen === true && specOther.oracle.cmd === undefined,
      'U2 another card\'s sealed standard is reduced to the fact that it exists, not its command or files');
    check(asSpec.tasks.some(t => t.id === 't-1' && t.subject === 'the contract stays visible'), 'U2 the card contract itself is still visible to this seat');
    check(!asSpec.summary.includes('Tuned to the instrument:'), 'U2 and the summary stops describing the candidate (the tuned-to-the-instrument declaration)');
    // #155: `current_cycle` was the one field that did NOT go through cycleExposure, so the whole
    // projection could be bypassed by reading it instead of `cycles`.
    check(asSpec.current_cycle?.id === 'c-1' && asSpec.current_cycle.step === 'GREEN'
      && asSpec.current_cycle.proposal === undefined && asSpec.current_cycle.green === undefined
      && asSpec.current_cycle.report === undefined && asSpec.current_cycle.red === undefined,
      'U2 the current cycle projection is the same one: only the step and the task survive');
    const whole = JSON.stringify(asSpec);
    check(!whole.includes('src/secret-approach.mjs') && !whole.includes('CANDIDATE-CORRECTION'),
      'U2 and neither a proposed file nor a correction text appears anywhere in the whole status the acceptance seat reads');
    // Still leaking, and named rather than tolerated: the tuned-to-the-instrument declaration reaches
    // this seat somewhere else (measured at offset 2572 in the serialised status, in a line shaped
    // "... pair_arbitrate(cycle:c-1:tuned) — tuned to the instrument: <text>"). Filed with the window
    // as #156; this assertion is what will close it.
    // The failure names the field, because this whole class of bypass was found one field at a time.
    const pathOf = (value, needle, path = '') => {
      if (typeof value === 'string') return value.includes(needle) ? path : undefined;
      if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) { const hit = pathOf(value[i], needle, path + '[' + i + ']'); if (hit !== undefined) return hit; } return undefined; }
      if (value && typeof value === 'object') { for (const key of Object.keys(value)) { const hit = pathOf(value[key], needle, path === '' ? key : path + '.' + key); if (hit !== undefined) return hit; } return undefined; }
      return undefined;
    };
    check(!whole.includes('the counter was fitted to the acceptance run'),
      'U2 #156 the tuned-to-the-instrument declaration reaches nowhere in this status (found at: ' + pathOf(asSpec, 'the counter was fitted to the acceptance run') + ')');
    check(asSpec.summary.includes('Goal coverage:') && asSpec.use_cases.length > 0, 'U2 the public contract it works from — goal coverage and the frozen use cases — is untouched');
    // U1 lifecycle projection: the board itself says which route each seat resolves to,
    // instead of leaving that to the settings card. A run on the captain fallback is
    // otherwise indistinguishable from a run with no override at all.
    check(asSpec.summary.includes('Seat routes: navigator=') && asSpec.summary.includes('driver=composed default') && asSpec.summary.includes('spec='),
      'U1 the board projects every acceptance seat route and the driver default');
    const asCaptain = await solo.status({}, { agent: solo.captain });
    check(asCaptain.cycles.find(c => c.id === 'c-1').pushbacks?.length === 1, 'U2 and the captain still reads why the candidate was sent back');
    check(asCaptain.cycles.find(c => c.id === 'c-1').green !== undefined && asCaptain.summary.includes('Tuned to the instrument:'),
      'U2 and the projection is seat-scoped: the captain still sees the candidate and that declaration');
    check(asCaptain.summary.includes('Seat routes:') && asCaptain.summary.includes('composed default'),
      'U1 and an undegraded run says so in the same line');
    check(isJsonValue(asSpec), 'U2 the projected status still passes the lossless-JSON gate');
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
