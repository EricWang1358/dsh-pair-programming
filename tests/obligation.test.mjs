/**
 * v3.1 loop-drive fixes, all derived from replaying two real v3 sessions:
 *
 *   session A: 23 captain send_message calls, phase stuck at PLANNING with 3/3
 *              tasks done, all three tasks spikes (so oracle-first never fired),
 *              all three oracles asserting only "does this probe file exist".
 *   session B: 151 captain send_message calls; 28 pair_propose, 35 pair_green,
 *              1 pair_oracle for 10 tasks, and ZERO pair_verify.
 *
 * Each check below pins the mechanism that would have caught one of those.
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextObligation, obligationLine, backPressure, unverifiedCycle, unverifiedCycles } from '../lib/protocol/obligation.js';
import * as obligations from '../lib/protocol/obligation.js';
import { advancePhase, initialProtocolState, openCycle } from '../lib/protocol/machine.js';
import { assessOracleReach } from '../lib/tools/oracle-exec.js';
import { reachWarning, freezeRecord, oracleSummary } from '../lib/protocol/oracle.js';
import { registerFlowTools } from '../lib/tools/flow.js';
import { createTeamDir, readTeam } from '../lib/state/store.js';

const task = (over = {}) => ({ id: 't-1', subject: 's', status: 'in_progress', assignee: 'driver', attemptId: 'a-1', dependencies: [], createdAt: 1, updatedAt: 1, ...over });
const member = (id, role) => ({ id, name: role, role, status: 'idle', joinedAt: 1 });

function teamFixture(over = {}) {
  return {
    id: 'ob1', name: 'OB', goal: 'g', mode: 'light', tddMode: 'enforce', pairStyle: 'traditional',
    captainSessionId: 'cap1', createdAt: 1, updatedAt: 1,
    members: [member('child-driver', 'driver'), member('child-nav', 'navigator')],
    tasks: [task()], taskSeq: 1, protocol: { ...initialProtocolState(), phase: 'PLANNING' }, evidenceStats: { cacheHits: 0, cacheMiss: 0 }, ...over,
  };
}

function flowHarness(root, stateDir) {
  const defs = [];
  const ctx = {
    logger: { warn: () => {}, debug: () => {}, error: () => {} },
    tools: { register: (d) => { defs.push(d); } },
    agents: { get: (id) => (id === 'cap1' ? { id: 'cap1', session: { append: () => {} } } : undefined) },
    subagents: { sendMessage: async () => 'm-1' },
  };
  registerFlowTools(ctx, { stateDir, tddMode: 'enforce', maxCyclesPerTask: 12, oracleFirst: true }, { scheduler: {} });
  const sess = (id) => ({ id, session: { header: { cwd: root }, append: () => {} } });
  return { tool: (n) => defs.find(d => d.name === n).execute, driver: sess('child-driver'), navigator: sess('child-nav'), stateRoot: join(root, stateDir) };
}

const fails = (fn) => fn().then(() => 'no throw', (e) => String(e?.message ?? e));

export async function run(check) {
  const root = await mkdtemp(join(tmpdir(), 'pair-ob-'));
  try {
    /* ---- A: the board names whose move it is ------------------------- */
    const t = teamFixture();
    check(nextObligation(t).tool === 'pair_oracle' && nextObligation(t).who === 'navigator', 'A a claimed task with no oracle owes the Navigator a SPEC-FORK');
    t.tasks[0].oracle = { sha: 'abc', files: [], cmd: 'x', chosen: 'c', divergences: [], redExit: 1 };
    check(nextObligation(t).tool === 'pair_propose' && nextObligation(t).who === 'driver', 'A a frozen oracle with no cycle owes the Driver a proposal');
    const cycle = openCycle(t.protocol, 't-1', { tddMode: 'enforce', oracleSha: 'abc' });
    check(nextObligation(t).tool === 'pair_review', 'A a PROPOSED cycle owes the Navigator a GO/NO_GO');
    cycle.step = 'GO';
    check(nextObligation(t).tool === 'pair_green' && nextObligation(t).who === 'driver', 'A a GO on an oracle cycle owes the Driver a GREEN (no Driver-authored RED)');
    cycle.step = 'GREEN';
    const owed = nextObligation(t);
    check(owed.tool === 'pair_verify' && owed.who === 'navigator', 'A THE session-B regression: a GREEN owes a verdict, and the board says so');
    check(obligationLine(owed).startsWith('[PAIR:NEXT] navigator owes pair_verify(cycle_id=') && obligationLine(owed).includes('cannot be asserted'), 'A the NEXT line names the caller, the tool, the cycle and the reason');
    cycle.verify = { verdict: 'accept', at: 2 };
    check(nextObligation(t).tool === 'pair_gate_check', 'A an accepted cycle owes the gate');
    check(obligationLine(undefined).includes('nothing is owed'), 'A an idle board says so rather than inventing a step');

    /* ---- B: back-pressure — one unverified cycle per task ------------ */
    const bp = teamFixture();
    bp.tasks[0].oracle = { sha: 'abc', files: [], cmd: 'x', chosen: 'c', divergences: [], redExit: 1 };
    const c1 = openCycle(bp.protocol, 't-1', { tddMode: 'enforce', oracleSha: 'abc' });
    check(backPressure(bp.protocol, 't-1').includes(`cycle ${c1.id}`), 'B an unverified cycle blocks a second one');
    check(backPressure(bp.protocol, 't-1').includes('pair_review'), 'B the refusal names who owes the outstanding call');
    check(unverifiedCycle(bp.protocol, 't-1')?.id === c1.id && unverifiedCycles(bp.protocol).length === 1, 'B the unverified set is exposed for status');
    c1.verify = { verdict: 'reject', at: 3 };
    c1.step = 'PROPOSED';
    check(backPressure(bp.protocol, 't-1')?.includes(c1.id), 'B a REJECT remains outstanding and blocks a replacement cycle');
    check(nextObligation(bp)?.tool === 'pair_review', 'B a rejected manual proposal can regain GO on its existing cycle');
    c1.verify = { verdict: 'checkpoint', at: 4 };
    c1.step = 'VERIFIED';
    check(backPressure(bp.protocol, 't-1') === undefined, 'B a checkpoint closes the cycle without claiming final acceptance');
    check(backPressure(bp.protocol, 't-2') === undefined, 'B back-pressure is per task, not team-wide');

    /* ---- B2: all current task debts survive global cycle ordering ------ */
    const frontier = (board, opts) => obligations.obligationFrontier(board, opts);
    check(typeof obligations.obligationFrontier === 'function', 'B2 the full deterministic task frontier is exposed');
    const multi = teamFixture({ tasks: [task({ oracle: { sha: 'abc' } }), task({ id: 't-2' }), task({ id: 't-done', status: 'completed' })] });
    multi.protocol.cycles = [
      { id: 'old-live', taskId: 't-1', step: 'GO', oracleSha: 'abc' },
      { id: 'new-done', taskId: 't-done', step: 'VERIFIED', verify: { verdict: 'accept' } },
    ];
    check(nextObligation(multi)?.cycleId === 'old-live', 'B2 a newer completed task cycle cannot hide an older live task debt');
    check(frontier(multi).length === 2 && frontier(multi).every(o => o.taskId !== 't-done'), 'B2 both live tasks are visible and terminal tasks contribute no cycle debt');
    check(nextObligation(multi, 'driver')?.cycleId === 'old-live' && nextObligation(multi, 'navigator')?.taskId === 't-2', 'B2 each recipient selects its own action without stealing another seat work');
    check(nextObligation(multi, 'challenger') === undefined, 'B2 a recipient with no obligation is not handed another seat action');
    const named = structuredClone(multi);
    named.members[0].name = 'builder';
    named.members[1].name = 'reviewer';
    named.tasks[0].assignee = 'builder';
    named.tasks[1].assignee = 'builder';
    check(nextObligation(named, 'reviewer')?.taskId === 't-2' && nextObligation(named, 'builder')?.cycleId === 'old-live', 'B2 recipient selection uses actual seat names instead of assuming role equals name');
    multi.protocol.cycles.push({ id: 'current-live', taskId: 't-1', step: 'GREEN', oracleSha: 'abc' });
    check(unverifiedCycle(multi.protocol, 't-1')?.id === 'old-live' && unverifiedCycles(multi.protocol).length === 2, 'B2 appending a new cycle cannot silently supersede an unfinished older cycle');
    multi.protocol.cycles[0].step = 'CLOSED';
    check(unverifiedCycle(multi.protocol, 't-1')?.id === 'current-live' && unverifiedCycles(multi.protocol).length === 1, 'B2 explicitly closed superseded cycles contribute no debt');
    const hidden = teamFixture({ tasks: [task({ oracle: { sha: 'abc' } })] });
    hidden.protocol.cycles = [
      { id: 'hidden-old', taskId: 't-1', step: 'GO', oracleSha: 'abc', verify: { verdict: 'reject' } },
      { id: 'newer-accept', taskId: 't-1', step: 'VERIFIED', oracleSha: 'abc', verify: { verdict: 'accept' } },
    ];
    check(nextObligation(hidden)?.cycleId === 'hidden-old' && nextObligation(hidden)?.tool === 'pair_green' && backPressure(hidden.protocol, 't-1')?.includes('hidden-old'), 'B2 newer acceptance cannot hide old unfinished same-task debt behind a permanently failing gate');

    const ready = teamFixture({ tasks: [
      task({ id: 'missing-dep', status: 'pending', dependencies: ['missing'] }),
      task({ id: 'failed-dep', status: 'failed' }),
      task({ id: 'blocked', status: 'pending', dependencies: ['failed-dep'] }),
      task({ id: 'done-dep', status: 'completed' }),
      task({ id: 'ready', status: 'pending', dependencies: ['done-dep'] }),
    ] });
    check(nextObligation(ready)?.tool === 'pair_task_claim' && nextObligation(ready)?.taskId === 'ready', 'B2 claims require all dependencies to exist and be completed');
    check(nextObligation(ready, 'navigator')?.tool === 'pair_oracle' && nextObligation(ready, 'navigator')?.taskId === 'ready', 'B2 a dependency-ready pending task permits oracle preparation without a task claim');
    ready.tasks.unshift(task({ id: 'working', oracle: { sha: 'abc' } }));
    check(!frontier(ready).some(o => o.tool === 'pair_task_claim'), 'B2 an active canonical task prevents another Driver claim');
    check(nextObligation(ready, 'navigator')?.taskId === 'ready' && nextObligation(ready, 'navigator')?.tool === 'pair_oracle_write', 'B2 future oracle work is draft-only while another canonical task is live; its command cannot race implementation');
    ready.protocol.cycles = [{ id: 'working-candidate', taskId: 'working', step: 'GO', oracleSha: 'abc' }];
    check(frontier(ready).some(o => o.taskId === 'ready' && o.preparationOnly), 'B3 current GO permits independent future drafts');
    for (const step of ['GREEN', 'REFACTOR', 'IMPLEMENTED', 'VERIFIED']) {
      ready.protocol.cycles[0].step = step;
      ready.protocol.cycles[0].verify = step === 'VERIFIED' ? { verdict: 'accept' } : undefined;
      check(!frontier(ready).some(o => o.taskId === 'ready'), `B3 current ${step} pauses future oracle drafts through the candidate verification window`);
    }
    ready.tasks[0].status = 'completed';
    check(nextObligation(ready, 'navigator')?.tool === 'pair_oracle', 'B2 future draft work becomes a freeze obligation after the canonical task finishes');
    const unfrozen = teamFixture({ tasks: [task(), task({ id: 't-2' })] });
    check(nextObligation(unfrozen, 'navigator')?.taskId === 't-1' && nextObligation(unfrozen, 'navigator')?.tool === 'pair_oracle', 'B2 a legacy board with two unfrozen live tasks can freeze the first instead of deadlocking on two drafts');

    const latest = teamFixture({ tasks: [task({ oracle: { sha: 'abc' } })] });
    latest.protocol.cycles = [
      { id: 'earlier-accept', taskId: 't-1', step: 'VERIFIED', verify: { verdict: 'accept' } },
      { id: 'latest', taskId: 't-1', step: 'VERIFIED', verify: { verdict: 'checkpoint' } },
    ];
    check(nextObligation(latest)?.tool === 'pair_propose', 'B2 a latest checkpoint is not hidden by an earlier ACCEPT');
    check(nextObligation(latest)?.why.includes('pair_verify(stage="final")'), 'B2 a completed task may promote its latest checkpoint without opening a needless new cycle');
    Object.assign(latest.protocol.cycles[1], { step: 'GO', oracleSha: 'abc', review: { auto: true, verdict: 'go' }, verify: { verdict: 'reject' } });
    check(nextObligation(latest)?.tool === 'pair_green' && unverifiedCycles(latest.protocol).length === 1, 'B2 a latest REJECT owes repair on the existing cycle rather than a gate or replacement');
    latest.protocol.cycles[1].step = 'GREEN';
    check(nextObligation(latest)?.tool === 'pair_verify', 'B2 a repaired GREEN with the old REJECT still recorded owes a fresh verifier verdict');
    latest.tasks[0].oracle.sha = 'replacement-seal';
    const mismatch = nextObligation(latest);
    check(mismatch?.who === 'captain' && mismatch?.tool === 'pair_arbitrate' && obligationLine(mismatch).includes('conflict_ref=latest'), 'B2 a re-forked seal with no legal cycle repair edge is an explicit captain decision with a valid tool argument');
    latest.protocol.cycles[1].verify = { verdict: 'accept' };
    latest.protocol.cycles[1].step = 'VERIFIED';
    delete latest.tasks[0].oracle;
    check(nextObligation(latest)?.tool === 'pair_gate_check', 'B2 accepted oracle-free work owes the gate, not an impossible retroactive oracle');

    const legacy = teamFixture({ tasks: [task({ trivial: true })] });
    check(nextObligation(legacy)?.tool === 'pair_propose', 'B2 trivial tasks retain the real oracle-first exemption');
    check(nextObligation(teamFixture(), undefined, { oracleFirst: false })?.tool === 'pair_propose', 'B2 disabled oracle-first policy does not invent an oracle obligation');
    const lc = openCycle(legacy.protocol, 't-1', { trivial: true, tddMode: 'enforce' });
    lc.step = 'GO';
    check(nextObligation(legacy)?.tool === 'pair_report', 'B2 trivial GO uses the legal report chain instead of an unavailable RED');
    lc.trivial = false;
    lc.step = 'GREEN';
    check(nextObligation(legacy)?.tool === 'pair_refactor', 'B2 legacy TDD GREEN owes refactor before the verifier can accept it');
    lc.step = 'CLOSED';
    check(unverifiedCycles(legacy.protocol).length === 0, 'B2 a closed legacy cycle is terminal even if its historical verdict is absent');

    const solo = teamFixture({ mode: 'solo', members: [member('child-spec', 'spec')], tasks: [task({ assignee: 'captain', trivial: true })] });
    check(nextObligation(solo)?.who === 'spec' && nextObligation(solo)?.tool === 'pair_oracle', 'B2 solo work needs a SPEC oracle because solo cannot self-assert a legacy verdict');
    solo.tasks[0].oracle = { sha: 'abc' };
    check(nextObligation(solo)?.who === 'captain' && nextObligation(solo)?.tool === 'pair_propose', 'B2 the solo captain owns implementation without a phantom Driver');
    const sc = openCycle(solo.protocol, 't-1', { oracleSha: 'abc' });
    sc.step = 'GREEN';
    check(nextObligation(solo)?.who === 'captain' && nextObligation(solo)?.tool === 'pair_verify', 'B2 solo computed verification belongs to the captain without a phantom Navigator');
    solo.members = [];
    solo.protocol.cycles = [];
    delete solo.tasks[0].oracle;
    check(nextObligation(solo)?.who === 'captain' && nextObligation(solo)?.tool === 'pair_arbitrate', 'B2 a missing SPEC seat is an explicit captain decision, not work owed by an absent member');
    for (const phase of ['DONE', 'ABORTED']) {
      const terminal = teamFixture({ protocol: { ...multi.protocol, phase } });
      check(nextObligation(terminal) === undefined && frontier(terminal).length === 0, `B2 ${phase} teams create no new task work`);
    }

    /* ---- C: the phase actually moves --------------------------------- */
    const p = initialProtocolState();
    p.phase = 'PLANNING';
    check(advancePhase(p, 'CYCLING') === true && p.phase === 'CYCLING', 'C PLANNING advances to CYCLING when a cycle opens');
    check(advancePhase(p, 'TASK_GATE') === true && p.phase === 'TASK_GATE', 'C a gate pass advances to TASK_GATE');
    check(advancePhase(p, 'CYCLING') === true && p.phase === 'CYCLING', 'C completing the task returns to CYCLING');
    check(advancePhase(p, 'PLANNING') === false && p.phase === 'CYCLING', 'C an illegal transition is refused, not silently applied');
    p.phase = 'DONE';
    check(advancePhase(p, 'CYCLING') === false && p.phase === 'DONE', 'C a finished team is never dragged back');

    /* ---- D: oracle reach --------------------------------------------- */
    await mkdir(join(root, '.pair-oracles', 't-1'), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'splitter.js'), 'export const x = 1;\n');
    const weak = join(root, '.pair-oracles', 't-1', 'weak.mjs');
    await writeFile(weak, 'import { existsSync } from "node:fs";\nprocess.exit(existsSync("probe.txt") ? 0 : 1);\n');
    const weakReach = await assessOracleReach(root, ['.pair-oracles/t-1/weak.mjs']);
    check(weakReach.selfContained === true, 'D THE session-A regression: an oracle that only checks for a file it will be handed is self-contained');
    const strong = join(root, '.pair-oracles', 't-1', 'strong.mjs');
    await writeFile(strong, 'import { x } from "src/splitter.js";\nprocess.exit(x === 2 ? 0 : 1);\n');
    const strongReach = await assessOracleReach(root, ['.pair-oracles/t-1/strong.mjs']);
    check(strongReach.selfContained === false && strongReach.touches.includes('src/splitter.js'), 'D an oracle referencing existing code reports its reach');
    const weakRec = freezeRecord({ readings: ['a', 'b'], chosen_reading: 'a', divergence_candidates: ['d'], oracle_files: ['x'], oracle_cmd: 'c' }, { sha: 'deadbeefdeadbeef', run: { exit: 1 }, by: 'navigator', reach: weakReach });
    check(reachWarning(weakRec).includes('cannot detect anything'), 'D a self-contained oracle earns an explicit warning');
    check(oracleSummary(weakRec).includes('SELF-CONTAINED'), 'D the summary carries the warning wherever the oracle is shown');
    check(reachWarning({ reach: strongReach }) === undefined, 'D an oracle with reach is not warned about');

    /* ---- E: end to end through the real tools ------------------------ */
    const h = flowHarness(root, 'ob-state');
    const live = teamFixture();
    live.tasks[0].oracle = { sha: 'abc', files: [], cmd: 'x', chosen: 'c', divergences: [], redExit: 1, frozenAt: 1 };
    await createTeamDir(h.stateRoot, live);
    const first = await h.tool('pair_propose')({ task_id: 't-1', intent: 'i', files: ['a.js'], net_lines: 3, verify_plan: 'v' }, { agent: h.driver });
    check(first.auto_go === true, 'E a small step still opens straight at GO');
    check((await readTeam(h.stateRoot, 'ob1')).protocol.phase === 'CYCLING', 'E THE session-A regression: opening a cycle moves the phase off PLANNING');
    const second = await fails(() => h.tool('pair_propose')({ task_id: 't-1', intent: 'i2', files: ['b.js'], net_lines: 3, verify_plan: 'v' }, { agent: h.driver }));
    check(second.includes('no verdict') && second.includes('stack unreviewed work'), 'E THE session-B regression: a second cycle is refused while the first is unverified');

    /* ---- F: no silent oracle bypass ---------------------------------- */
    const sp = flowHarness(root, 'ob-spike');
    const spikeTeam = teamFixture({ id: 'ob2', members: [member('d2', 'driver'), member('n2', 'navigator')], tasks: [task({ type: 'spike' })] });
    await createTeamDir(sp.stateRoot, spikeTeam);
    const spikeAgent = { id: 'd2', session: { header: { cwd: root }, append: () => {} } };
    const refused = await fails(() => sp.tool('pair_propose')({ task_id: 't-1', intent: 'i', files: ['a.js'], net_lines: 3, verify_plan: 'v' }, { agent: spikeAgent }));
    check(refused.includes('no frozen oracle') && refused.includes('no_oracle_reason'), 'F THE session-A regression: a spike is no longer silently exempt from oracle-first');
    const allowed = await sp.tool('pair_propose')({ task_id: 't-1', intent: 'i', files: ['a.js'], net_lines: 3, verify_plan: 'v', no_oracle_reason: 'deliverable is a go/no-go decision, not code' }, { agent: spikeAgent });
    check(allowed.cycle_id !== undefined, 'F a stated reason lets the spike proceed');
    const recorded = (await readTeam(sp.stateRoot, 'ob2')).protocol.cycles[0];
    check(recorded.noOracleReason.includes('go/no-go'), 'F the exemption is recorded on the cycle, so it can be audited instead of vanishing');
    const spikeNav = { id: 'n2', session: { header: { cwd: root }, append: () => {} } };
    const repair = async (cycleId = allowed.cycle_id) => {
      await sp.tool('pair_red')({ cycle_id: cycleId, test_files: ['probe.js'], red_evidence: ['probe is failing'] }, { agent: spikeAgent });
      await sp.tool('pair_green')({ cycle_id: cycleId, green_evidence: ['probe now passes'], tuned_for_oracle: 'none' }, { agent: spikeAgent });
      await sp.tool('pair_refactor')({ cycle_id: cycleId, diff_summary: 'the decision probe', test_results: 'probe passes', refactor_evidence: ['no cleanup needed'] }, { agent: spikeAgent });
    };
    await repair();
    await sp.tool('pair_verify')({ cycle_id: allowed.cycle_id, verdict: 'reject', evidence: ['probe misses the empty case'], observation: 'The decision probe omits the empty input case.', impact: 'Its decision is unsupported for empty input.', way_forward: 'Add the empty input case to the decision probe.' }, { agent: spikeNav });
    const rejected = await readTeam(sp.stateRoot, 'ob2');
    check(nextObligation(rejected)?.tool === 'pair_red' && nextObligation(rejected)?.cycleId === allowed.cycle_id, 'F a real rejected legacy auto-GO cycle names a legal repair action');
    const stackedRepair = await fails(() => sp.tool('pair_propose')({ task_id: 't-1', intent: 'replacement', files: ['a.js'], net_lines: 3, verify_plan: 'node --version', no_oracle_reason: 'decision probe' }, { agent: spikeAgent }));
    check(stackedRepair.includes(allowed.cycle_id), 'F real pair_propose cannot hide an outstanding REJECT in a replacement cycle');
    await repair();
    await sp.tool('pair_verify')({ cycle_id: allowed.cycle_id, verdict: 'accept', evidence: ['empty input now covered'] }, { agent: spikeNav });
    check(unverifiedCycles((await readTeam(sp.stateRoot, 'ob2')).protocol).length === 0, 'F the existing repair tools can close the same rejected cycle after a fresh verdict');
    const manual = await sp.tool('pair_propose')({ task_id: 't-1', intent: 'probe a second decision', files: ['a.js', 'b.js'], net_lines: 90, why_not_split: 'The paired fixtures test one indivisible decision.', verify_plan: 'node --version', no_oracle_reason: 'deliverable is a decision probe' }, { agent: spikeAgent });
    await sp.tool('pair_review')({ cycle_id: manual.cycle_id, verdict: 'go', evidence: ['the proposal has one decision concern'] }, { agent: spikeNav });
    await repair(manual.cycle_id);
    await sp.tool('pair_verify')({ cycle_id: manual.cycle_id, verdict: 'reject', evidence: ['second branch was omitted'], observation: 'The decision probe omits the second branch.', impact: 'The resulting decision can select the wrong branch.', way_forward: 'Cover the second branch and report its result.' }, { agent: spikeNav });
    check(nextObligation(await readTeam(sp.stateRoot, 'ob2'))?.tool === 'pair_review', 'F real manual-review rejection reopens review on the existing proposal');
    await sp.tool('pair_review')({ cycle_id: manual.cycle_id, verdict: 'go', evidence: ['the existing proposal scope covers the requested repair'], conditions: 'Cover both branches before the next verdict.' }, { agent: spikeNav });
    await repair(manual.cycle_id);
    check(nextObligation(await readTeam(sp.stateRoot, 'ob2'))?.tool === 'pair_verify', 'F repair after renewed manual GO reaches verification despite the prior recorded REJECT');
    await sp.tool('pair_verify')({ cycle_id: manual.cycle_id, verdict: 'accept', evidence: ['both branches covered'] }, { agent: spikeNav });
    check(unverifiedCycles((await readTeam(sp.stateRoot, 'ob2')).protocol).length === 0, 'F a manual-review rejected cycle also closes through real existing repair APIs');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
