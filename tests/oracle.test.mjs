/**
 * v3 oracle-first protocol: SPEC-FORK validation, the frozen digest, computed
 * verdicts, the board digest, and the end-to-end cycle the redesign specifies.
 */
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forkProblems, redProblem, computeVerdict, freezeRecord, oracleSummary, resolveCycleOracle } from '../lib/protocol/oracle.js';
import { digestOracleFiles, runOracleCommand, resolveInside } from '../lib/tools/oracle-exec.js';
import { boardDigest, DIGEST_BUDGET_CHARS } from '../lib/protocol/digest.js';
import { memberIsStale } from '../lib/runtime/recycle.js';
import { registerFlowTools } from '../lib/tools/flow.js';
import { registerOracleTools } from '../lib/tools/oracle.js';
import { registerArbitrateTools } from '../lib/tools/arbitrate.js';
import { createTeamDir, readTeam, writeTeam } from '../lib/state/store.js';
import { withLock } from '../lib/state/lock.js';
import { teamLockKey } from '../lib/state/layout.js';
import { initialProtocolState } from '../lib/protocol/machine.js';
import { gateStateFingerprint } from '../lib/protocol/gate.js';
import { assertTaskOracleFiles, resolveTaskOracleFile } from '../lib/tools/oracle-exec.js';

const GOOD_FORK = {
  readings: [
    'every valid regex must be expressible, so the splitter must not break inside a brace quantifier',
    'the user may escape a comma to keep it, so a backslash-comma is a literal comma',
  ],
  chosen_reading: 'every valid regex must be expressible, so the splitter must not break inside a brace quantifier',
  divergence_candidates: ['a hidden test may assert the unescaped form "a{1,3}" round-trips, which the escape reading fails'],
  oracle_files: ['.pair-oracles/t-1/accept.mjs'],
  oracle_cmd: 'node .pair-oracles/t-1/accept.mjs',
};

function memberOf(id, role) {
  return { id, name: role, role, status: 'idle', joinedAt: 1 };
}

function taskOf(over = {}) {
  return { id: 't-1', subject: 'fix the splitter', description: 'the request, verbatim', status: 'in_progress', assignee: 'driver', attemptId: 'a-1', dependencies: [], createdAt: 1, updatedAt: 1, ...over };
}

function teamFixture(over = {}) {
  return {
    id: 'ot1', name: 'OT', goal: 'fix the splitter', mode: 'light', tddMode: 'enforce', pairStyle: 'traditional',
    captainSessionId: 'cap1', createdAt: 1, updatedAt: 1,
    members: [memberOf('child-driver', 'driver'), memberOf('child-nav', 'navigator')],
    tasks: [taskOf()], taskSeq: 1, protocol: initialProtocolState(), evidenceStats: { cacheHits: 0, cacheMiss: 0 }, ...over,
  };
}

function harness(root, stateDir, cfg = {}) {
  const defs = [];
  const ctx = {
    logger: { warn: () => {}, debug: () => {}, error: () => {} },
    tools: { register: (d) => { defs.push(d); } },
    agents: { get: (id) => (id === 'cap1' ? { id: 'cap1', session: { append: () => {} } } : undefined) },
    subagents: { sendMessage: async () => 'm-1' },
  };
  const config = { stateDir, tddMode: 'enforce', maxCyclesPerTask: 12, oracleFirst: true, evidenceCache: false, ...cfg };
  registerFlowTools(ctx, config, { scheduler: {} });
  registerOracleTools(ctx, config);
  registerArbitrateTools(ctx, config, { scheduler: {} });
  const sess = (id) => ({ id, session: { header: { cwd: root }, append: () => {} } });
  return {
    tool: (name) => defs.find(d => d.name === name).execute,
    driver: sess('child-driver'), navigator: sess('child-nav'), captain: sess('cap1'),
    stateRoot: join(root, stateDir),
  };
}

const fails = (fn, needle) => fn().then(() => `no throw (expected ${needle})`, (e) => String(e?.message ?? e));

export async function run(check) {
  const runA={artifactNamespace:'run-a'},runB={artifactNamespace:'run-b'};
  check(resolveTaskOracleFile(process.cwd(),'t-1','.pair-oracles/run-a/t-1/check.cjs',runA)!==resolveTaskOracleFile(process.cwd(),'t-1','.pair-oracles/run-b/t-1/check.cjs',runB),'same task ids in separate runs resolve to independent files');
  for(const path of ['.pair-oracles/t-1/check.cjs','.pair-oracles/run-b/t-1/check.cjs','.pair-oracles/run-a/t-1/../../run-b/check.cjs']){
    let rejected=false;try{resolveTaskOracleFile(process.cwd(),'t-1',path,runA);}catch{rejected=true;}check(rejected,'namespaced oracle rejects shared, foreign or escaping path '+path);
  }
  check(assertTaskOracleFiles('t-1',['.pair-oracles/t-1/legacy.cjs'],{})==='.pair-oracles/t-1','legacy frozen paths stay valid without migration');

  const root = await mkdtemp(join(tmpdir(), 'pair-oracle-'));
  try {
    const scoped=harness(root,'scoped-state');
    await createTeamDir(scoped.stateRoot,teamFixture({artifactNamespace:'run-a'}));
    const scopedPath='.pair-oracles/run-a/t-1/accept.cjs';
    await scoped.tool('pair_oracle_write')({task_id:'t-1',path:scopedPath,content:'process.exit(1);'},{agent:scoped.navigator});
    check(await readFile(join(root,scopedPath),'utf8')==='process.exit(1);','real oracle writer uses the persisted run namespace');
    check((await fails(()=>scoped.tool('pair_oracle_write')({task_id:'t-1',path:'.pair-oracles/run-b/t-1/accept.cjs',content:'other'},{agent:scoped.navigator}))).includes('run-a'),'real oracle writer refuses a different run namespace');
    const prepRoot = join(root, 'preparation'); await mkdir(prepRoot);
    const prep = harness(prepRoot, 'state');
    const prepBoard = teamFixture({ id: 'preparation', tasks: [taskOf({ oracle: { sha: 'current-seal' } }), taskOf({ id: 'future', status: 'pending', assignee: undefined })] });
    prepBoard.protocol.cycles = [{ id: 'candidate', taskId: 't-1', step: 'GO', oracleSha: 'current-seal', review: { verdict: 'go' } }];
    await createTeamDir(prep.stateRoot, prepBoard);
    const draftArgs = { task_id: 'future', path: '.pair-oracles/future/draft.mjs', content: 'process.exit(1);\n' };
    const draft = await prep.tool('pair_oracle_write')(draftArgs, { agent: prep.navigator });
    check(draft.bytes === Buffer.byteLength(draftArgs.content), 'P current GO permits future oracle drafting through the real writer');
    const freezeArgs = { ...GOOD_FORK, task_id: 'future', oracle_files: [draftArgs.path], oracle_cmd: 'node .pair-oracles/future/draft.mjs' };
    check((await fails(() => prep.tool('pair_oracle')(freezeArgs, { agent: prep.navigator }))).includes('current canonical task'), 'P a future draft cannot freeze or run its command while the canonical task is live');
    for (const step of ['GREEN', 'IMPLEMENTED', 'REFACTOR', 'VERIFIED']) {
      prepBoard.protocol.cycles[0].step = step;
      prepBoard.protocol.cycles[0].verify = step === 'VERIFIED' ? { verdict: 'accept' } : undefined;
      await writeTeam(prep.stateRoot, prepBoard);
      const paused = await fails(() => prep.tool('pair_oracle_write')({ ...draftArgs, content: 'pause must keep original' }, { agent: prep.navigator }));
      check(paused.includes('preparation paused') && await readFile(join(prepRoot, draftArgs.path), 'utf8') === draftArgs.content, `P ${step} pauses future oracle file writes without changing bytes`);
    }
    prepBoard.tasks[0].status = 'completed'; await writeTeam(prep.stateRoot, prepBoard);
    check((await prep.tool('pair_oracle_write')(draftArgs, { agent: prep.navigator })).bytes > 0, 'P current terminal status resumes future drafts');
    check((await prep.tool('pair_oracle')(freezeArgs, { agent: prep.navigator })).oracle_sha?.length === 64, 'P current terminal status resumes a real failing oracle freeze');

    // A held real team lock lets GREEN win before a queued writer re-reads.
    prepBoard.tasks[0].status = 'in_progress'; prepBoard.protocol.cycles[0].step = 'GO'; delete prepBoard.protocol.cycles[0].verify;
    await writeTeam(prep.stateRoot, prepBoard);
    let releaseLock, lockEntered; const lockGate = new Promise(resolve => { releaseLock = resolve; });
    const inLock = new Promise(resolve => { lockEntered = resolve; });
    const locked = withLock(teamLockKey(prep.stateRoot, prepBoard.id), async () => { lockEntered(); await lockGate; prepBoard.protocol.cycles[0].step = 'GREEN'; await writeTeam(prep.stateRoot, prepBoard); });
    await inLock;
    let settledWhileLocked = false;
    const queuedDraft = fails(() => prep.tool('pair_oracle_write')({ ...draftArgs, content: 'queued forbidden change' }, { agent: prep.navigator })).then(result => { settledWhileLocked = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 100));
    check(!settledWhileLocked, 'P oracle write waits for the same team lock used by candidate transitions');
    releaseLock(); await locked;
    const queuedResult = await queuedDraft;
    check(queuedResult.includes('preparation paused') && await readFile(join(prepRoot, draftArgs.path), 'utf8') === draftArgs.content, 'P queued writer revalidates the latest GREEN window inside the lock before changing a file');
    // Delay the real filesystem boundary, then send the real Driver tool.
    // The wrapper still performs mkdir; it injects latency, not a fake write.
    prepBoard.protocol.cycles[0].step = 'GO'; await writeTeam(prep.stateRoot, prepBoard);
    const delayedArgs = { ...draftArgs, path: '.pair-oracles/future/delayed/accept.mjs' };
    const realMkdir = fs.promises.mkdir;
    let fileEntered, releaseFile;
    const fileEntry = new Promise(resolve => { fileEntered = resolve; });
    const fileGate = new Promise(resolve => { releaseFile = resolve; });
    let delayedWrite, concurrentGreen, entryTimer;
    try {
      fs.promises.mkdir = async (...args) => {
        const result = await realMkdir(...args);
        if (String(args[0]) === join(prepRoot, '.pair-oracles', 'future', 'delayed')) { fileEntered(); await fileGate; }
        return result;
      };
      syncBuiltinESMExports();
      delayedWrite = prep.tool('pair_oracle_write')(delayedArgs, { agent: prep.navigator });
      await Promise.race([
        fileEntry,
        delayedWrite.then(() => { throw new Error('oracle writer completed without reaching the filesystem boundary'); }),
        new Promise((_, reject) => { entryTimer = setTimeout(() => reject(new Error('oracle writer never reached the filesystem boundary')), 15000); }),
      ]);
      concurrentGreen = prep.tool('pair_green')({ cycle_id: 'candidate', green_evidence: ['candidate passes'], diff_summary: 'candidate', test_results: 'green', tuned_for_oracle: 'none' }, { agent: prep.driver });
      await new Promise(resolve => setTimeout(resolve, 100));
      check((await readTeam(prep.stateRoot, prepBoard.id)).protocol.cycles[0].step === 'GO', 'P a real pair_green cannot record its candidate while a future oracle file write is still in flight');
    } finally {
      clearTimeout(entryTimer); releaseFile(); fs.promises.mkdir = realMkdir; syncBuiltinESMExports();
      await Promise.all([delayedWrite, concurrentGreen]);
    }
    check(await readFile(join(prepRoot, delayedArgs.path), 'utf8') === delayedArgs.content && (await readTeam(prep.stateRoot, prepBoard.id)).protocol.cycles[0].step === 'GREEN', 'P future draft commits completely before the queued real GREEN transition');
    const currentDraft = { ...draftArgs, task_id: 't-1', path: '.pair-oracles/t-1/repair.mjs' };
    check((await prep.tool('pair_oracle_write')(currentDraft, { agent: prep.navigator })).bytes > 0, 'P the current task oracle author is not stranded by the future-task preparation pause');
    prepBoard.protocol.phase = 'RETRO'; await writeTeam(prep.stateRoot, prepBoard);
    check((await fails(() => prep.tool('pair_oracle_write')({ ...draftArgs, task_id: 't-1', path: '.pair-oracles/t-1/draft.mjs' }, { agent: prep.navigator }))).includes('closed'), 'P oracle writer rejects a dispatch-closed team even for its current task');
    prepBoard.protocol.phase = 'CYCLING'; prepBoard.protocol.cycles = []; prepBoard.tasks[0].status = 'completed'; await writeTeam(prep.stateRoot, prepBoard);
    check((await fails(() => prep.tool('pair_oracle_write')({ ...draftArgs, task_id: 't-1', path: '.pair-oracles/t-1/draft.mjs' }, { agent: prep.navigator }))).includes('terminal'), 'P oracle writer rejects terminal tasks without relying on an ACCEPT record');
    /* ---- pure: SPEC-FORK validation ---------------------------------- */
    check(forkProblems(GOOD_FORK).length === 0, 'A a complete fork validates');
    check(forkProblems({ ...GOOD_FORK, readings: [GOOD_FORK.readings[0]] })[0].includes('at least 2 distinct interpretations'), 'A one reading is refused — the fork is the point');
    check(forkProblems({ ...GOOD_FORK, readings: [GOOD_FORK.readings[0], GOOD_FORK.readings[0].toUpperCase()] })[0].includes('restatement'), 'A a restated reading is not a second interpretation');
    check(forkProblems({ ...GOOD_FORK, chosen_reading: 'something else entirely' })[0].includes('one of the readings'), 'A the chosen reading must be one you listed');
    check(forkProblems({ ...GOOD_FORK, divergence_candidates: [] })[0].includes('divergence_candidates'), 'A a fork without divergence candidates is refused');
    check(forkProblems({ ...GOOD_FORK, oracle_files: [] })[0].includes('frozen under a digest'), 'A an oracle with no files cannot be frozen');
    check(forkProblems({ ...GOOD_FORK, oracle_cmd: '  ' })[0].includes('oracle_cmd'), 'A an oracle with no command is refused');

    /* ---- pure: RED requirement and computed verdicts ------------------ */
    check(redProblem({ exit: 0 }).includes('PASSES on the untouched tree'), 'B an oracle that already passes is not an oracle');
    check(redProblem({ exit: 1 }) === undefined && redProblem({ exit: 'timeout' }).includes('timed out'), 'B a failing oracle is RED, a hanging one is refused');
    check(computeVerdict({ run: { exit: 0 } }).verdict === 'accept', 'B a passing frozen oracle accepts');
    check(computeVerdict({ run: { exit: 1 } }).verdict === 'reject', 'B a failing frozen oracle rejects');
    const tampered = computeVerdict({ tampered: true, run: { exit: 0 } });
    check(tampered.verdict === 'reject' && tampered.category === 'oracle_tampered', 'B a tampered oracle rejects even when it now passes');
    check(oracleSummary(undefined) === 'none' && oracleSummary(freezeRecord(GOOD_FORK, { sha: 'abcdef0123456789', run: { exit: 1 }, by: 'navigator' })).includes('abcdef012345'), 'B the summary names the seal');

    /* ---- digest: stable, sensitive, escape-proof ---------------------- */
    await mkdir(join(root, '.pair-oracles', 't-1'), { recursive: true });
    const oraclePath = join(root, '.pair-oracles', 't-1', 'accept.mjs');
    await writeFile(oraclePath, 'process.exit(process.env.FIXED === "1" ? 0 : 1);\n');
    const d1 = await digestOracleFiles(root, ['.pair-oracles/t-1/accept.mjs']);
    const d2 = await digestOracleFiles(root, ['.pair-oracles/t-1/accept.mjs']);
    check(d1 === d2 && d1.length === 64, 'C the digest is stable across reads');
    await writeFile(oraclePath, 'process.exit(process.env.FIXED === "1" ? 0 : 1); // touched\n');
    check(await digestOracleFiles(root, ['.pair-oracles/t-1/accept.mjs']) !== d1, 'C one changed character changes the digest');
    check((await digestOracleFiles(root, ['.pair-oracles/t-1/missing.mjs'])).length === 64, 'C a missing oracle file hashes as a tombstone instead of crashing');
    let escaped = 'allowed';
    try { resolveInside(root, '../escape.mjs'); } catch (e) { escaped = String(e.message); }
    check(escaped.includes('outside the workspace'), 'C an oracle path escaping the workspace is refused');

    /* ---- exec: exit codes ------------------------------------------- */
    const red = await runOracleCommand(root, 'node .pair-oracles/t-1/accept.mjs');
    check(red.exit !== 0 && red.outputSha.length === 64, 'D the oracle command reports a nonzero exit and hashes its output');

    /* ---- E2E: the v3 cycle ------------------------------------------- */
    const h = harness(root, 'oracle-state');
    await createTeamDir(h.stateRoot, teamFixture());
    const nativeOracleWrite = await h.tool('pair_oracle_write')({ task_id: 't-1', path: '.pair-oracles/t-1/accept.mjs', content: 'process.exit(process.env.FIXED === "1" ? 0 : 1);\n' }, { agent: h.navigator });
    check(nativeOracleWrite.bytes > 0, 'E0 Navigator can author a test only through the narrow oracle writer');
    const productionWrite = await fails(() => h.tool('pair_oracle_write')({ task_id: 't-1', path: 'src/a.js', content: 'production change' }, { agent: h.navigator }), 'reserved root');
    check(productionWrite.includes('must be under .pair-oracles/t-1/'), 'E0 oracle writer cannot target production source');
    // E1: no oracle -> the Driver cannot open a cycle.
    const noOracle = await fails(() => h.tool('pair_propose')({ task_id: 't-1', intent: 'fix it', files: ['src/a.js'], verify_plan: 'run tests' }, { agent: h.driver }), 'oracle');
    check(noOracle.includes('no frozen oracle') && noOracle.includes('pair_oracle'), 'E1 pair_propose refuses a task whose acceptance standard is not frozen');
    // E2: the Driver cannot freeze its own oracle.
    const wrongRole = await fails(() => h.tool('pair_oracle')({ task_id: 't-1', ...GOOD_FORK }, { agent: h.driver }), 'navigator');
    check(wrongRole.includes('only the Navigator'), 'E2 only the Navigator freezes the oracle');
    // E3: an oracle that already passes is refused at the tool boundary.
    await writeFile(oraclePath, 'process.exit(0);\n');
    const green0 = await fails(() => h.tool('pair_oracle')({ task_id: 't-1', ...GOOD_FORK }, { agent: h.navigator }), 'passes');
    check(green0.includes('PASSES on the untouched tree'), 'E3 the freeze is refused while the oracle already passes');
    // E4: freeze for real.
    await writeFile(oraclePath, 'process.exit(process.env.FIXED === "1" ? 0 : 1);\n');
    const frozen = await h.tool('pair_oracle')({ task_id: 't-1', ...GOOD_FORK }, { agent: h.navigator });
    check(frozen.oracle_sha.length === 64 && frozen.red_exit !== 0, 'E4 the oracle freezes with a digest and a recorded RED');
    // E5: a small step opens straight at GO and inherits the oracle RED.
    const proposed = await h.tool('pair_propose')({ task_id: 't-1', intent: 'brace-aware split', files: ['src/a.js'], net_lines: 12, verify_plan: 'node .pair-oracles/t-1/accept.mjs' }, { agent: h.driver });
    check(proposed.auto_go === true && proposed.step === 'GO', 'E5 a one-file, 12-line step skips the GO round (R4)');
    let board = await readTeam(h.stateRoot, 'ot1');
    check(board.protocol.cycles[0].red?.fromOracle === true, 'E5 the cycle inherits the frozen oracle as its RED');
    check(board.protocol.cycles[0].oracleSha === frozen.oracle_sha, 'E5 the cycle is stamped with the seal it will be judged against');
    // E6: GREEN must carry the report (no separate refactor round).
    const bareGreen = await fails(() => h.tool('pair_green')({ cycle_id: proposed.cycle_id, green_evidence: ['ok'], tuned_for_oracle: 'none' }, { agent: h.driver }), 'diff_summary');
    // Goodhart, made declarable. A computed verdict re-runs the sealed command
    // and passes by construction; beyond_request asks what was done BEYOND the
    // request, and tuning to the instrument is the opposite shape — the product
    // made smaller, dimmer or moved so a threshold clears. Measured twice in
    // one live session: a rain effect dropped 0.4 -> 0.18 opacity "so the idle
    // patches stay under the diff threshold", and a rain volume shrunk from
    // +/-6 to +/-4.85 after a footprint assertion failed, then justified after
    // the fact as "the correct look for a collectible miniature". Neither was
    // visible anywhere on the board.
    const untuned = await fails(() => h.tool('pair_green')({ cycle_id: proposed.cycle_id, green_evidence: ['ok'], diff_summary: 'd', test_results: 't' }, { agent: h.driver }), 'tuned_for_oracle');
    check(untuned.includes('tuned_for_oracle') || untuned.includes('required'), 'GREEN cannot be recorded without declaring what was tuned to the oracle rather than to the request');
    const blank = await fails(() => h.tool('pair_green')({ cycle_id: proposed.cycle_id, green_evidence: ['ok'], diff_summary: 'd', test_results: 't', tuned_for_oracle: '   ' }, { agent: h.driver }), 'blank');
    check(blank.includes('blind'), 'and an empty declaration is refused with the reason: a re-run is structurally blind to a product bent to fit its own instrument');
    check(bareGreen.includes('folds REFACTOR into GREEN'), 'E6 an oracle cycle refuses a GREEN with no report (R5)');
    await h.tool('pair_green')({ cycle_id: proposed.cycle_id, green_evidence: ['oracle green'], diff_summary: 'src/a.js +9/-2', test_results: 'suite ok', tuned_for_oracle: 'none' }, { agent: h.driver });
    // E7: the oracle still fails -> the verdict is REJECT however it is asserted.
    const rejected = await h.tool('pair_verify')({ cycle_id: proposed.cycle_id, verdict: 'accept', evidence: ['looks right to me'] }, { agent: h.navigator });
    check(rejected.verdict === 'reject' && rejected.computed === true && rejected.category === 'oracle_red', 'E7 an asserted ACCEPT cannot override a failing oracle');
    // E8: a rejected auto-GO cycle rewinds to GO, not into a dead end.
    board = await readTeam(h.stateRoot, 'ot1');
    check(board.protocol.cycles[0].step === 'GO', 'E8 a rejected auto-GO cycle rewinds to GO so the Driver can re-run GREEN');
    process.env.FIXED = '1';
    await h.tool('pair_green')({ cycle_id: proposed.cycle_id, green_evidence: ['oracle green'], diff_summary: 'src/a.js +9/-2', test_results: 'suite ok', tuned_for_oracle: 'none' }, { agent: h.driver });
    const bareAccept = await fails(() => h.tool('pair_verify')({ cycle_id: proposed.cycle_id }, { agent: h.navigator }));
    check(bareAccept.includes('needs a scope reading') && bareAccept.includes('beyond_request'), 'E8 an ACCEPT on a green oracle still requires someone to have read the diff');
    const accepted = await h.tool('pair_verify')({ cycle_id: proposed.cycle_id, beyond_request: 'nothing — the hunk is the minimal brace-aware split', preexisting_at_risk: 'the list/tuple passthrough; re-ran the existing config suite' }, { agent: h.navigator });
    check(accepted.verdict === 'accept' && accepted.computed === true, 'E8 a passing oracle accepts with no verdict argument at all');
    // A green re-run is blind to behaviour nobody requested. In a measured
    // run a comma fix also rewrote an existing list/tuple contract; the
    // oracle passed and the whole regression suite passed 18/18.
    const duplicateAccept = await fails(() => h.tool('pair_verify')({ cycle_id: proposed.cycle_id }, { agent: h.navigator }));
    check(duplicateAccept.includes('already completed'), 'E8 a final ACCEPT cannot be rewritten by a duplicate call');
    // E9: the gate replays the oracle itself.
    const pass = await h.tool('pair_gate_check')({ task_id: 't-1' }, { agent: h.captain });
    check(pass.pass === true && pass.oracle_replay.ok === true, 'E9 the gate replays the frozen oracle and passes');
    // A gate credential is not a reusable receipt: it is bound to both the
    // exact oracle and the worktree that passed it.
    await writeFile(oraclePath, 'process.exit(0); // changed after pass\n');
    const staleOracle = await fails(() => h.tool('pair_task_update')({ task_id: 't-1', status: 'completed', attempt_id: 'a-1', gate_pass_id: pass.gate_pass_id }, { agent: h.driver }), 'oracle stale');
    check(staleOracle.includes('GATE_STALE') && staleOracle.includes('frozen oracle changed'), 'E9 a post-gate oracle edit invalidates the credential');
    await writeFile(oraclePath, 'process.exit(process.env.FIXED === "1" ? 0 : 1);\n');
    const refreshed = await h.tool('pair_gate_check')({ task_id: 't-1' }, { agent: h.captain });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'after-gate.mjs'), 'export const changedAfterGate = true;\n');
    const staleTree = await fails(() => h.tool('pair_task_update')({ task_id: 't-1', status: 'completed', attempt_id: 'a-1', gate_pass_id: refreshed.gate_pass_id }, { agent: h.driver }), 'tree stale');
    check(staleTree.includes('GATE_STALE') && staleTree.includes('worktree changed'), 'E9 a post-gate source edit invalidates the credential');
    // E10: editing the oracle is caught by the gate and by verification.
    await writeFile(oraclePath, 'process.exit(0); // always green now\n');
    const tamperedGate = await fails(() => h.tool('pair_gate_check')({ task_id: 't-1' }, { agent: h.captain }));
    check(tamperedGate.includes('GATE_STALE') && tamperedGate.includes('final review'), 'E10 a rewritten candidate/oracle needs a fresh final review even though it now passes');
    const nextCycle = await h.tool('pair_propose')({ task_id: 't-1', intent: 'take 3', files: ['src/a.js'], net_lines: 5, verify_plan: 'node .pair-oracles/t-1/accept.mjs' }, { agent: h.driver });
    await h.tool('pair_green')({ cycle_id: nextCycle.cycle_id, green_evidence: ['green'], diff_summary: 'src/a.js +1/-1', test_results: 'ok', tuned_for_oracle: 'none' }, { agent: h.driver });
    const tamperVerdict = await h.tool('pair_verify')({ cycle_id: nextCycle.cycle_id }, { agent: h.navigator });
    check(tamperVerdict.verdict === 'reject' && tamperVerdict.category === 'oracle_tampered', 'E10 verification rejects a moved seal outright');
    delete process.env.FIXED;

    /* ---- board digest ------------------------------------------------ */
    board = await readTeam(h.stateRoot, 'ot1');
    const digest = boardDigest(board, { memberName: 'driver', role: 'driver' });
    check(digest.includes('Task t-1') && digest.includes('SEALED') && digest.includes('Divergence candidates'), 'F the digest carries the task, the seal and the open divergences');
    check(digest.length < DIGEST_BUDGET_CHARS, 'F the digest fits its budget');
    const fat = boardDigest({ ...board, goal: 'g'.repeat(400), processLessons: { keep: ['k'.repeat(200)], try: ['t'.repeat(200)] } }, { budget: 400 });
    check(fat.includes('digest truncated'), 'F an over-budget digest says what it dropped instead of truncating silently');

    /* ---- seat recycling ---------------------------------------------- */
    const accCycle = board.protocol.cycles.find(c => c.verify?.verdict === 'accept');
    check(memberIsStale(board, { id: 'x', name: 'driver', status: 'idle', joinedAt: 1 }) === true, 'G a seat older than an accepted cycle is stale');
    check(memberIsStale(board, { id: 'x', name: 'driver', status: 'idle', joinedAt: (accCycle.verify.at ?? 0) + 1000 }) === false, 'G a seat spawned after the last acceptance is current');
    check(memberIsStale(board, { id: '', name: 'driver', status: 'idle', joinedAt: 1 }) === false, 'G an unspawned seat is never recycled');

    /* ---- H: one source of truth, no conflicting instruction ---------- */
    // H1: the cycle stamp and the task record are two views of one seal.
    check(resolveCycleOracle({ id: 'c1' }, { oracle: { sha: 'a' } }).oracle === undefined, 'H1 a cycle with no stamp resolves to no oracle');
    const agreed = resolveCycleOracle({ id: 'c1', oracleSha: 'a' }, { oracle: { sha: 'a' } });
    check(agreed.oracle !== undefined && agreed.error === undefined, 'H1 a matching stamp and record resolve cleanly');
    check(resolveCycleOracle({ id: 'c1', oracleSha: 'a' }, { oracle: { sha: 'b' } }).error.includes('re-forked mid-cycle'), 'H1 a re-forked oracle under a live cycle is refused, not silently preferred');
    check(resolveCycleOracle({ id: 'c1', oracleSha: 'a' }, {}).error.includes('no longer carries'), 'H1 a vanished oracle under a stamped cycle is refused');
    // H2: re-freezing under an in-flight cycle is refused at the tool.
    const h2 = harness(root, 'oracle-state-2');
    await createTeamDir(h2.stateRoot, teamFixture({ id: 'ot2' }));
    await writeFile(oraclePath, 'process.exit(process.env.FIXED === "1" ? 0 : 1);\n');
    delete process.env.FIXED;
    await h2.tool('pair_oracle')({ task_id: 't-1', ...GOOD_FORK }, { agent: h2.navigator });
    const live = await h2.tool('pair_propose')({ task_id: 't-1', intent: 'i', files: ['src/a.js'], net_lines: 4, verify_plan: 'v' }, { agent: h2.driver });
    const refork = await fails(() => h2.tool('pair_oracle')({ task_id: 't-1', ...GOOD_FORK }, { agent: h2.navigator }), 'in flight');
    check(refork.includes('is in flight') && refork.includes('never shown'), 'H2 the oracle cannot be re-forked under an in-flight cycle');
    // G3: the seal itself being invalid is the one case that MUST cross an in-flight
    // cycle. Otherwise the instrument can only be repaired by first driving a standard
    // nobody can satisfy to a verdict, which is the lock this fixes.
    const beforeRepair = await readTeam(h2.stateRoot, 'ot2');
    const invalidSeal = beforeRepair.tasks[0].oracle.sha;
    const stepBefore = beforeRepair.protocol.cycles.find(c => c.id === live.cycle_id).step;
    await writeFile(oraclePath, 'const absent = globalThis.__neverImplemented;\nif (absent === undefined) { console.log("acceptance not met"); process.exit(1); }\nprocess.exit(0);\n');
    const repaired = await h2.tool('pair_oracle')({ task_id: 't-1', ...GOOD_FORK, fork_kind: 'defect', defect_evidence: 'the sealed artifact asserted a helper this repository has never had, so the run failed identically at every verdict and no implementation could satisfy it' }, { agent: h2.navigator });
    check(repaired.oracle_sha?.length === 64 && repaired.oracle_sha !== invalidSeal, 'G3 a DEFECT fork re-freezes under an in-flight cycle instead of locking the instrument');
    const afterRepair = await readTeam(h2.stateRoot, 'ot2');
    const liveCycle = afterRepair.protocol.cycles.find(c => c.id === live.cycle_id);
    check(liveCycle.oracleSha === afterRepair.tasks[0].oracle.sha, 'G3 and the open cycle is re-stamped onto the repaired seal, so the frontier does not strand it');
    check(liveCycle.oracleRepair?.fromOracleSha === invalidSeal && String(liveCycle.oracleRepair.defectEvidence).length > 0, 'G3 with the replaced digest AND the defect evidence recorded on the cycle itself');
    check(liveCycle.step === stepBefore && liveCycle.step !== 'CLOSED', 'G3 and the Driver keeps its cycle, at the same step: the repair changes the standard it is judged by, not the work it did');
    check(resolveCycleOracle(liveCycle, afterRepair.tasks[0]).error === undefined, 'G3 and the repaired cycle resolves cleanly against the task record');
    // G5: a defect re-freeze of the same bytes and an interpretation fork used to be
    // distinguishable only by their number, which is how a session lost track of which
    // seal was current.
    check(repaired.summary.includes('freeze #2 (kind=defect') && repaired.summary.includes('reason:'),
      'G5 a re-freeze names its KIND and its reason, so the current seal is not a guess');
    check(repaired.interpretation_forks_left === 2 && repaired.freeze_kind === 'defect',
      'G5 and a defect fork reports the interpretation budget it did NOT consume');
    // H3: the legacy step tools refuse an oracle cycle by naming the right move.
    const redAdvice = await fails(() => h2.tool('pair_red')({ cycle_id: live.cycle_id, test_files: ['t.mjs'], red_evidence: ['fails'] }, { agent: h2.driver }), 'oracle');
    check(redAdvice.includes('IS its RED') && redAdvice.includes('pair_green'), 'H3 pair_red on an oracle cycle names the oracle, not a chain error');
    const reportAdvice = await fails(() => h2.tool('pair_report')({ cycle_id: live.cycle_id, diff_summary: 'd', test_results: 't' }, { agent: h2.driver }), 'oracle');
    check(reportAdvice.includes('reports through pair_green') && !reportAdvice.includes('pair_refactor'), 'H3 pair_report no longer advises the v2 chain on an oracle cycle');
    const refactorAdvice = await fails(() => h2.tool('pair_refactor')({ cycle_id: live.cycle_id, diff_summary: 'd', test_results: 't' }, { agent: h2.driver }), 'oracle');
    check(refactorAdvice.includes('folds REFACTOR into GREEN'), 'H3 pair_refactor on an oracle cycle names the fold');

    /* ---- I: staged verification preserves small cycles --------------- */
    const h3 = harness(root, 'oracle-state-3');
    await createTeamDir(h3.stateRoot, teamFixture({ id: 'ot3' }));
    const stagedOracle = `import { readFileSync } from 'node:fs';\nlet value = '';\ntry { value = readFileSync('src/staged.txt', 'utf8').trim(); } catch {}\nprocess.exit(value === 'complete' ? 0 : 1);\n`;
    await h3.tool('pair_oracle_write')({ task_id: 't-1', path: '.pair-oracles/t-1/accept.mjs', content: stagedOracle }, { agent: h3.navigator });
    await h3.tool('pair_oracle')({ task_id: 't-1', ...GOOD_FORK }, { agent: h3.navigator });
    const slice1 = await h3.tool('pair_propose')({
      task_id: 't-1', intent: 'land the first independently checkable slice', files: ['src/staged.txt'], net_lines: 1,
      verify_plan: `node -e "const f=require('fs');process.exit(f.readFileSync('src/staged.txt','utf8').includes('partial')?0:1)"`,
    }, { agent: h3.driver });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'staged.txt'), 'partial\n');
    await h3.tool('pair_green')({ cycle_id: slice1.cycle_id, green_evidence: ['slice command green'], diff_summary: 'partial slice', test_results: 'slice green', tuned_for_oracle: 'none' }, { agent: h3.driver });
    const checkpoint = await h3.tool('pair_verify')({ cycle_id: slice1.cycle_id, stage: 'checkpoint' }, { agent: h3.navigator });
    check(checkpoint.verdict === 'checkpoint' && checkpoint.category === 'checkpoint_green', 'I a checkpoint executes the predeclared slice command and closes the cycle without claiming final acceptance');
    let stagedBoard = await readTeam(h3.stateRoot, 'ot3');
    check(stagedBoard.protocol.cycles[0].step === 'VERIFIED' && stagedBoard.protocol.cycles[0].verify.verdict === 'checkpoint', 'I the checkpoint is durable and releases back-pressure');
    const prematureGate = await h3.tool('pair_gate_check')({ task_id: 't-1' }, { agent: h3.captain });
    check(prematureGate.pass === false && prematureGate.failures.join(' ').includes('no final oracle ACCEPT'), 'I checkpoints alone cannot pass the task gate');

    const slice2 = await h3.tool('pair_propose')({ task_id: 't-1', intent: 'complete the contract', files: ['src/staged.txt'], net_lines: 1, verify_plan: 'node .pair-oracles/t-1/accept.mjs' }, { agent: h3.driver });
    await writeFile(join(root, 'src', 'staged.txt'), 'complete\n');
    await h3.tool('pair_green')({ cycle_id: slice2.cycle_id, green_evidence: ['full oracle green'], diff_summary: 'complete slice', test_results: 'full green', tuned_for_oracle: 'none' }, { agent: h3.driver });
    const final = await h3.tool('pair_verify')({ cycle_id: slice2.cycle_id, stage: 'final', beyond_request: 'nothing', preexisting_at_risk: 'staged file only; full oracle rerun' }, { agent: h3.navigator });
    check(final.verdict === 'accept', 'I the final stage still requires the full frozen oracle');
    const stagedPass = await h3.tool('pair_gate_check')({ task_id: 't-1' }, { agent: h3.captain });
    check(stagedPass.pass === true && stagedPass.checklist.checkpointCycles.includes(slice1.cycle_id), 'I the gate accepts settled checkpoints only alongside a final ACCEPT and records them');
    const completed = await h3.tool('pair_task_update')({ task_id: 't-1', status: 'completed', attempt_id: 'a-1', gate_pass_id: stagedPass.gate_pass_id, output: 'two small verified slices' }, { agent: h3.driver });
    stagedBoard = await readTeam(h3.stateRoot, 'ot3');
    const storedPass = stagedBoard.protocol.gatePasses.find(pass => pass.id === stagedPass.gate_pass_id);
    check(completed.status === 'completed' && stagedBoard.tasks[0].gatePassId === stagedPass.gate_pass_id
      && gateStateFingerprint(stagedBoard, 't-1') === storedPass.binding.gateStateSha,
    'I the board-bound gate credential remains authoritative across the legitimate completion transition');
    // G1: an artifact that does not parse cannot become the standard. Measured by the
    // r4 session: two seats read a 796-line oracle line by line, BOTH cited the broken
    // line, and the freeze still sealed it — because a parse error exits 1, which is
    // exactly what the freeze requires its RED to do.
    const g1Root = join(root, 'g1'); await mkdir(g1Root, { recursive: true });
    const g1 = harness(g1Root, 'state');
    await createTeamDir(g1.stateRoot, teamFixture({ id: 'g1team' }));
    const brokenPath = '.pair-oracles/t-1/broken.mjs';
    const broken = 'const quote = "never closed\nprocess.exit(1);\n';
    const refusedDraft = await fails(() => g1.tool('pair_oracle_write')({ task_id: 't-1', path: brokenPath, content: broken }, { agent: g1.navigator }), 'does not parse');
    check(refusedDraft.includes('does not parse'), 'G1 the writer refuses a draft that does not parse');
    check(fs.existsSync(join(g1Root, brokenPath)) === false, 'G1 and writes nothing, so a good artifact is never replaced by a broken one');
    await mkdir(join(g1Root, '.pair-oracles', 't-1'), { recursive: true });
    await writeFile(join(g1Root, brokenPath), broken);
    const refusedFreeze = await fails(() => g1.tool('pair_oracle')({ task_id: 't-1', ...GOOD_FORK, oracle_files: [brokenPath], oracle_cmd: 'node ' + brokenPath }, { agent: g1.navigator }), 'VERIFICATION_INFRASTRUCTURE');
    check(refusedFreeze.includes('VERIFICATION_INFRASTRUCTURE') && refusedFreeze.includes('does not parse'), 'G1 an unparseable artifact reaches no seal: the freeze refuses it as an instrument problem');
    check((await readTeam(g1.stateRoot, 'g1team')).tasks[0].oracle === undefined, 'G1 and the task carries no oracle after that refusal');
    await writeFile(join(g1Root, brokenPath), 'const absent = globalThis.__nothingImplementedYet;\nif (absent === undefined) { console.log("acceptance not met"); process.exit(1); }\nprocess.exit(0);\n');
    const healthy = await g1.tool('pair_oracle')({ task_id: 't-1', ...GOOD_FORK, oracle_files: [brokenPath], oracle_cmd: 'node ' + brokenPath }, { agent: g1.navigator });
    check(healthy.oracle_sha?.length === 64, 'G1 a valid acceptance artifact still freezes RED - the parse gate does not block real work');
    // G4: the freeze reports the artifact beside the digest — per file its sha256, its
    // byte count and its line count. Three confusions in one session came from a seal
    // that printed nothing else.
    check(healthy.artifact_metrics?.files?.[0]?.sha256?.length === 64
      && healthy.artifact_metrics.bytes > 0 && healthy.artifact_metrics.lines > 0,
    'G4 the freeze reports the artifact it sealed: per-file sha256, bytes and lines');
    check(healthy.summary.includes('artifact ') && healthy.summary.includes('file sha256')
      && healthy.artifact_metrics.files[0].sha256.startsWith(healthy.summary.match(/file sha256 ([0-9a-f]+)/)[1]),
    'G4 and the board summary carries the same numbers the digest was computed over');
    check(healthy.freeze_kind === 'interpretation' && healthy.interpretation_forks_left === 2,
    'G5 the freeze says which kind it is and how much interpretation budget is left');
  } finally {
    delete process.env.FIXED;
    await rm(root, { recursive: true, force: true });
  }
}
