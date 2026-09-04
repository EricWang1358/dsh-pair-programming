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
    check(backPressure(bp.protocol, 't-1') === undefined, 'B a verdict — even a REJECT — releases the back-pressure');
    check(backPressure(bp.protocol, 't-2') === undefined, 'B back-pressure is per task, not team-wide');

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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
