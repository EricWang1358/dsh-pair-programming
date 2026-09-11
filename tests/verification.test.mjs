/** Real commands and rendezvous files exercise the async evidence boundary. */
import { mkdtemp, rm, writeFile, readFile, mkdir, access } from 'node:fs/promises';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerFlowTools } from '../lib/tools/flow.js';
import { registerOracleTools } from '../lib/tools/oracle.js';
import { registerArbitrateTools } from '../lib/tools/arbitrate.js';
import { createTeamDir, readTeam, writeTeam } from '../lib/state/store.js';
import { initialProtocolState, openCycle } from '../lib/protocol/machine.js';
import { runGate } from '../lib/protocol/gate.js';
import { completionReadiness } from '../lib/protocol/completion.js';
import { digestOracleFiles, workspaceFingerprint, runOracleCommand } from '../lib/tools/oracle-exec.js';
import { navigatorPersona } from '../lib/protocol/personas.js';
import { usageSectionText } from '../lib/prompt.js';
import { oraclePreparationWindow } from '../lib/protocol/obligation.js';

const execFileP = promisify(execFile);
const scope = { beyond_request: 'nothing', preexisting_at_risk: 'product.txt checked independently' };
const veto = { verdict: 'reject', evidence: ['counterexample: empty input loses its value'], observation: 'Empty input loses its value in product.txt.', impact: 'Existing callers receive a wrong result.', way_forward: 'Preserve the empty input value and add a regression case.' };
const oracleFile = '.pair-oracles/t-1/accept.mjs';
const command = `node ${oracleFile}`;
const oracleText = "import { readFileSync } from 'node:fs'; process.exit(readFileSync('product.txt','utf8') === 'ok' ? 0 : 1);\n";
const fork = { readings: ['empty input must retain its original value', 'empty input should normalize to a default'], chosen_reading: 'empty input must retain its original value', divergence_candidates: ['normalizing an empty input may discard an intentional value'], oracle_files: [oracleFile], oracle_cmd: command };
const resultOf = promise => promise.then(value => ({ value }), error => ({ error: String(error.message) }));

async function fixture(configOver = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pair-verification-'));
  const stateDir = '.state';
  await mkdir(join(root, '.pair-oracles/t-1'), { recursive: true });
  await mkdir(join(root, stateDir), { recursive: true });
  await writeFile(join(root, oracleFile), oracleText);
  await writeFile(join(root, 'product.txt'), 'ok');
  const protocol = initialProtocolState();
  const cycle = openCycle(protocol, 't-1', { tddMode: 'enforce' });
  Object.assign(cycle, { step: 'GREEN', oracleSha: await digestOracleFiles(root, [oracleFile]), proposal: { files: ['product.txt'], verify_plan: command }, review: { verdict: 'go', auto: true, at: 2 }, red: { evidence: ['real baseline red'], at: 1 }, green: { evidence: ['green'], at: 3 }, report: { diff_summary: 'product repair', test_results: 'green', at: 3 } });
  const team = { id: 'v1', name: 'verification', goal: 'repair', mode: 'light', tddMode: 'enforce', captainSessionId: 'cap', createdAt: 1, updatedAt: 1, members: [{ id: 'drv', name: 'driver', role: 'driver', status: 'idle' }, { id: 'nav', name: 'navigator', role: 'navigator', status: 'idle' }], tasks: [{ id: 't-1', subject: 'repair', description: 'preserve values', dependencies: [], status: 'in_progress', assignee: 'driver', attemptId: 'attempt-1', createdAt: 1, updatedAt: 1, oracle: { sha: cycle.oracleSha, files: [oracleFile], cmd: command, frozenAt: 1, forks: 1, caseRefs: [] } }], taskSeq: 1, protocol };
  for (const member of team.members) member.joinedAt = 1;
  const config = { stateDir, evidenceCache: false, tddMode: 'enforce', maxCyclesPerTask: 20, oracleFirst: true, ...configOver };
  const defs = [];
  const ctx = { logger: { warn() {}, debug() {}, error() {} }, tools: { register: d => defs.push(d) }, agents: { get: () => undefined }, subagents: { sendMessage: async () => 'msg' } };
  registerFlowTools(ctx, config, { scheduler: {} }); registerOracleTools(ctx, config); registerArbitrateTools(ctx, config, { scheduler: {} });
  const agent = id => ({ id, session: { header: { cwd: root }, append() {} } });
  const stateRoot = join(root, stateDir);
  await createTeamDir(stateRoot, team);
  return { root, stateRoot, cycleId: cycle.id, board: () => readTeam(stateRoot, team.id),
    edit: async fn => { const fresh = await readTeam(stateRoot, team.id); fn(fresh); await writeTeam(stateRoot, fresh); },
    call: (name, args, id = 'nav', signal) => defs.find(d => d.name === name).execute(args, { agent: agent(id), signal }),
    verify(args = {}, signal, id = 'nav') { return this.call('pair_verify', { cycle_id: cycle.id, ...scope, ...args }, id, signal); },
    green() { return this.call('pair_green', { cycle_id: cycle.id, green_evidence: ['reran green'], diff_summary: 'fresh repair', test_results: 'green', tuned_for_oracle: 'none' }, 'drv'); },
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) };
}

async function waitForFile(dir, name) {
  let watcher;
  let timer;
  await new Promise((resolve, reject) => {
    const probe = () => access(join(dir, name)).then(resolve, () => {});
    watcher = watch(dir, probe);
    timer = setTimeout(() => reject(new Error(`rendezvous never arrived: ${name}`)), 15000);
    probe();
  }).finally(() => { watcher?.close(); clearTimeout(timer); });
}

async function rendezvous(h, prefix = 'run') {
  const path = join(h.stateRoot, `${prefix}.mjs`);
  await writeFile(path, `import { writeFileSync, existsSync, watch } from 'node:fs';
const base = '.state/${prefix}';
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { watcher.close(); reject(new Error('release missing')); }, 15000);
  const probe = () => { if (existsSync(base + '.release')) { clearTimeout(timer); watcher.close(); resolve(); } };
  const watcher = watch('.state', probe);
  writeFileSync(base + '.ready', 'ready'); probe();
});
`);
  return { command: `node .state/${prefix}.mjs`, entered: () => waitForFile(h.stateRoot, `${prefix}.ready`), release: () => writeFile(join(h.stateRoot, `${prefix}.release`), 'release') };
}

export async function run(check) {
  async function scenario(name, fn, config) {
    const h = await fixture(config);
    try { await fn(h); } catch (error) { check(false, `${name}: unexpected ${error.message}`); }
    finally { await h.cleanup(); }
  }
  await scenario('review veto', async h => {
    const answer = await h.verify(veto);
    check(answer.verdict === 'reject' && answer.category === 'reviewer_reject', 'U3 green oracle cannot override independent reviewer veto');
    const c = (await h.board()).protocol.cycles[0];
    check(c.verify?.testOutcome?.verdict === 'accept' && c.verify.feedback?.observation === veto.observation && c.verify.evidence.includes(veto.evidence[0]), 'U3 reviewer veto preserves independently gathered evidence and computed green outcome');
    check((await resultOf(h.verify())).error?.includes('GREEN'), 'U3 rejected cycle needs fresh GREEN before another verification');
    await h.green();
    check((await h.verify()).verdict === 'accept', 'U3 a real repair report permits final acceptance after rejection');
    const prior = JSON.stringify((await h.board()).protocol.cycles[0]);
    check((await resultOf(h.verify())).error?.includes('already'), 'U3 duplicate final acceptance is refused');
    check((await resultOf(h.call('pair_review', { cycle_id: h.cycleId, ...veto, verdict: 'no_go' }, 'nav'))).error !== undefined, 'U3 NO_GO cannot rewind a completed cycle');
    check(JSON.stringify((await h.board()).protocol.cycles[0]) === prior, 'U3 duplicate calls preserve completed verdict history');
  });
  await scenario('checkpoint veto and promotion', async h => {
    check((await h.verify({ ...veto, stage: 'checkpoint' })).verdict === 'reject', 'U3 green checkpoint preserves reviewer veto');
    await h.green();
    check((await h.verify({ stage: 'checkpoint' })).verdict === 'checkpoint', 'U3 repair can receive checkpoint');
    check((await h.verify()).verdict === 'accept', 'U3 latest checkpoint can promote to final ACCEPT');
  });
  await scenario('validation before execution', async h => {
    const markerCommand = `node -e "require('fs').writeFileSync('.state/executed','yes')"`;
    await h.edit(t => { t.tasks[0].oracle.cmd = markerCommand; });
    for (const args of [{ verdict: 'maybe' }, { verdict: 'reject' }, { ...veto, evidence: [] }, { stage: 'unknown' }]) {
      check((await resultOf(h.verify(args))).error !== undefined, 'U3 malformed verdict/stage/veto refuses the call');
    }
    check(await access(join(h.stateRoot, 'executed')).then(() => false, () => true), 'U3 invalid verdicts execute no commands');
    check((await h.board()).protocol.stats.reject === 0, 'U3 malformed calls consume no rejection budget');
    check((await resultOf(h.call('pair_review', { cycle_id: h.cycleId, verdict: 'maybe', evidence: ['e'] }))).error !== undefined, 'U3 proposal review validates verdict input');
  });
  for (const [name, mutation] of [
    ['reassigned attempt', t => { t.tasks[0].attemptId = 'attempt-2'; t.tasks[0].assignee = 'replacement'; }],
    ['new report', t => { t.protocol.cycles[0].report.diff_summary = 'changed while running'; }],
    ['new cycle', t => { openCycle(t.protocol, 't-1'); }],
    ['closed team', t => { t.protocol.phase = 'DONE'; }],
    ['terminal task', t => { t.tasks[0].status = 'cancelled'; }],
    ['changed reviewer', t => { t.members[1].role = 'driver'; }],
    // U4: a seat REPLACED while its evidence runs. The stamp carries the seat identity,
    // so the run that started under the old generation cannot land a verdict under the
    // new one — the late-result case, without needing a new concept on the board.
    ['replaced seat', t => { t.members[1].id = 'nav-2'; t.members[1].joinedAt = 2; }],
  ]) await scenario(`verify race ${name}`, async h => {
    const gate = await rendezvous(h);
    await h.edit(t => { t.tasks[0].oracle.cmd = gate.command; });
    const pending = resultOf(h.verify());
    await gate.entered(); await h.edit(mutation); await gate.release();
    const result = await pending;
    check(result.error?.includes('STALE'), `U3 verification refuses ${name} during command`);
    check((await h.board()).protocol.stats.reject === 0 && (await h.board()).protocol.cycles[0].verify === undefined, `U3 ${name} does not mutate verdict or rejection budget`);
  });
  // U4: a SUPERSEDED generation cannot land a result after the fact. The property is
  // checked on the outcome — the refusal, the untouched board, and the seat that does
  // hold the generation still working — so it does not depend on which guard fires first.
  await scenario('a superseded seat cannot land its result', async h => {
    await h.edit(t => { t.members[1].id = 'nav-2'; t.members[1].joinedAt = 2; });
    // pair_verify is the tool that stamps evidence: it resolves the actor through
    // requireLiveEvidenceTarget, so a replaced seat is refused before any command runs.
    const late = await resultOf(h.verify());
    // Which guard fires first is an implementation detail — a replaced seat may be
    // refused when the tool resolves its team, or at the evidence boundary. What must
    // hold is that it is refused AS A STALE ACTOR rather than judged on its product, and
    // that it writes nothing (asserted below).
    check(late.error !== undefined && /seat|belong|STALE/.test(late.error),
      'U4 the superseded generation cannot land evidence: it is refused as an actor that no longer holds a seat, not judged');
    check((await h.board()).protocol.cycles[0].verify === undefined, 'U4 and the late result left no verdict on the board');
    const fresh = await resultOf(h.verify({}, undefined, 'nav-2'));
    check(fresh.error === undefined || /seat|belong|STALE/.test(fresh.error) === false,
      'U4 while the generation that DOES hold the seat is never refused as a stale actor (control)');
  });
  await scenario('self mutation', async h => {
    await h.edit(t => { t.tasks[0].oracle.cmd = `node -e "require('fs').writeFileSync('product.txt','different')"`; });
    check((await resultOf(h.verify())).error?.includes('STALE'), 'U3 command changing candidate refuses stale evidence');
    check((await h.board()).protocol.stats.reject === 0, 'U3 candidate drift is not a product rejection');
  });
  await scenario('oracle self mutation', async h => {
    await h.edit(t => { t.tasks[0].oracle.cmd = `node -e "require('fs').appendFileSync('${oracleFile}','// mutation')"`; });
    check((await resultOf(h.verify())).error?.includes('STALE'), 'U3 command changing sealed oracle refuses stale evidence');
  });
  await scenario('concurrent final calls', async h => {
    const one = await rendezvous(h, 'one');
    const two = await rendezvous(h, 'two');
    await writeFile(join(h.stateRoot, 'dispatch.mjs'), `import { openSync } from 'node:fs'; let first = true; try { openSync('.state/claim', 'wx'); } catch { first = false; } await import(first ? './one.mjs' : './two.mjs');`);
    await h.edit(t => { t.tasks[0].oracle.cmd = 'node .state/dispatch.mjs'; });
    const pending = [resultOf(h.verify()), resultOf(h.verify())];
    await Promise.all([one.entered(), two.entered()]);
    await one.release(); await two.release();
    const results = await Promise.all(pending);
    check(results.filter(r => r.value?.verdict === 'accept').length === 1 && results.filter(r => r.error?.includes('STALE') || r.error?.includes('already')).length === 1, 'U3 concurrent final verifications commit exactly one verdict');
  });
  await scenario('infrastructure and cancellation', async h => {
    await h.edit(t => { t.tasks[0].oracle.cmd = 'pair_command_that_does_not_exist_4832'; });
    check((await resultOf(h.verify())).error?.includes('INFRASTRUCTURE'), 'U3 command not found is infrastructure failure, not REJECT');
    const controller = new AbortController(); controller.abort();
    check((await resultOf(h.verify({}, controller.signal))).error?.includes('CANCELLED'), 'U3 pre-cancelled verification refuses the call');
    check((await h.board()).protocol.stats.reject === 0, 'U3 infrastructure/cancellation charges no product rejection');
    const timed = await runOracleCommand(h.root, 'node -e "setTimeout(()=>{},150)"', { timeoutMs: 30 });
    check(timed.exit === 'timeout', 'U3 command timeout is an explicit infrastructure exit');
  });
  for (const [name, mutation] of [['board', h => h.edit(t => { t.tasks[0].description = 'changed task'; })], ['candidate', h => writeFile(join(h.root, 'product.txt'), 'new candidate')]]) {
    await scenario(`gate race ${name}`, async h => {
      const gate = await rendezvous(h);
      await writeFile(join(h.stateRoot, 'gate-dispatch.mjs'), "import { existsSync } from 'node:fs'; if (existsSync('.state/gate-active')) await import('./run.mjs');");
      await h.edit(t => { t.tasks[0].oracle.cmd = 'node .state/gate-dispatch.mjs'; });
      await h.verify();
      await writeFile(join(h.stateRoot, 'gate-active'), 'active');
      const pending = resultOf(h.call('pair_gate_check', { task_id: 't-1' }, 'cap'));
      await gate.entered(); await mutation(h); await gate.release();
      check((await pending).error?.includes('STALE'), `U3 gate refuses ${name} changing during replay`);
      check((await h.board()).protocol.gatePasses.length === 0, `U3 stale ${name} gate issues no credential`);
    });
  }
  await scenario('gate DoD mutation', async h => {
    await h.verify();
    check((await resultOf(h.call('pair_gate_check', { task_id: 't-1' }, 'cap'))).error?.includes('STALE'), 'U3 self-mutating DoD cannot certify its post-command tree');
  }, { dodCommand: `node -e "require('fs').writeFileSync('product.txt','mutated')"` });
  await scenario('latest relevant final cycle', async h => {
    await h.verify();
    const team = await h.board();
    team.protocol.cycles.push({ ...structuredClone(team.protocol.cycles[0]), id: 'new-checkpoint', verify: { verdict: 'checkpoint', computed: true, evidence: ['green'] } });
    check(!runGate(team, 't-1', { dod: ['all_accepted'] }).pass, 'U3 older ACCEPT cannot hide newer checkpoint');
  });
  await scenario('oracle re-fork recovery', async h => {
    await h.verify(veto);
    await writeFile(join(h.root, 'product.txt'), 'broken');
    const frozen = await h.call('pair_oracle', { task_id: 't-1', ...fork });
    const old = (await h.board()).protocol.cycles[0];
    check(old.step === 'CLOSED' && old.closure?.reason === 'oracle-replaced' && old.closure?.oracleSha === frozen.oracle_sha && old.verify.verdict === 'reject', 'U3 re-freeze explicitly closes superseded rejection without deleting evidence');
    const fresh = await h.call('pair_propose', { task_id: 't-1', intent: 'repair under replacement oracle', files: ['product.txt'], verify_plan: command, net_lines: 1 }, 'drv');
    await writeFile(join(h.root, 'product.txt'), 'ok');
    await h.call('pair_green', { cycle_id: fresh.cycle_id, green_evidence: ['real oracle green'], diff_summary: 'repair', test_results: 'green', tuned_for_oracle: 'none' }, 'drv');
    check((await h.call('pair_verify', { cycle_id: fresh.cycle_id, ...scope })).verdict === 'accept', 'U3 re-fork permits a new repair cycle');
    check((await h.call('pair_gate_check', { task_id: 't-1' }, 'cap')).pass === true, 'U3 rejection -> re-fork -> new GREEN -> verification -> gate succeeds');
  });
  await scenario('re-fork repair in progress', async h => {
    await h.verify(veto); await h.green();
    await writeFile(join(h.root, 'product.txt'), 'broken');
    check((await resultOf(h.call('pair_oracle', { task_id: 't-1', ...fork }))).error?.includes('in flight'), 'U3 old reject receipt cannot authorize re-fork over fresh repair GREEN');
  });
  await scenario('freeze self mutation', async h => {
    await h.edit(t => { t.protocol.cycles = []; delete t.tasks[0].oracle; });
    const selfMutate = `node -e "require('fs').appendFileSync('${oracleFile}','// modified');process.exit(1)"`;
    check((await resultOf(h.call('pair_oracle', { task_id: 't-1', ...fork, oracle_cmd: selfMutate }))).error?.includes('STALE'), 'U3 RED freeze cannot seal an oracle that rewrites itself');
    check((await h.board()).tasks[0].oracle === undefined, 'U3 rejected freeze creates no seal');
  });
  await scenario('git HEAD fingerprint', async h => {
    // K2-4: pinned against the developer's git config, and bounded.
  const GIT_PINS = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', '-c', 'core.pager=cat', '-c', 'advice.detachedHead=false'];
  const git = args => execFileP('git', [...GIT_PINS, ...args], { cwd: h.root, timeout: 60_000 });
    await git(['init']); await git(['config', 'user.name', 'Verification Fixture']); await git(['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(join(h.root, '.gitignore'), '.state/\n');
    await git(['add', '.']); await git(['commit', '-m', 'first candidate']);
    const first = await workspaceFingerprint(h.root, { stateDir: '.state' });
    await writeFile(join(h.root, 'product.txt'), 'second candidate');
    await git(['add', 'product.txt']); await git(['commit', '-m', 'second candidate']);
    check(await workspaceFingerprint(h.root, { stateDir: '.state' }) !== first, 'U3 two clean committed candidates have different fingerprints');
  });
  await runDirectoryRecovery(check);
  await runFollowups(check);
  await runReviewRegressions(check);
  await runClosureRegression(check);
}

export async function runFollowups(check) {
  const navigator = navigatorPersona({ name: 'Review fixture', tddMode: 'enforce' }, { name: 'navigator' }, '.state');
  const usage = usageSectionText();
  check(navigator.includes('verdict="reject"') && navigator.includes('evidence[], observation, impact and way_forward') && !navigator.includes('verdict is whatever that produces'), 'U3 Navigator instructions grant evidenced veto instead of mandatory agreement with oracle');
  check(usage.includes('pair_mailbox_read') && usage.includes('green oracle cannot override') && usage.includes('latest cycle must have a final ACCEPT'), 'U3 captain usage exposes bounded mailbox recovery and current verification authority');
  async function scenario(name, fn, config) {
    const h = await fixture(config);
    try { await fn(h); } catch (error) { check(false, `${name}: unexpected ${error.message}`); }
    finally { await h.cleanup(); }
  }
  await scenario('older outstanding review', async h => {
    await h.edit(t => { t.protocol.cycles.push({ ...structuredClone(t.protocol.cycles[0]), id: 'newer-accepted', step: 'VERIFIED', verify: { verdict: 'accept', computed: true, evidence: ['accepted'] } }); });
    check((await h.verify()).verdict === 'accept', 'U3 older unfinished review projected by U1 remains actionable');
  });
  await scenario('changed candidate after review', async h => {
    await h.verify();
    const stored = (await h.board()).protocol.cycles[0].verify;
    check(typeof stored.binding?.worktreeSha === 'string', 'U3 final reviewer acceptance retains its candidate binding');
    await writeFile(join(h.root, 'extra.txt'), 'unreviewed but oracle stays green');
    const response = await resultOf(h.call('pair_gate_check', { task_id: 't-1' }, 'cap'));
    check(response.error?.includes('STALE') || response.value?.failures?.some(text => text.includes('review')), 'U3 gate refuses code changed after final review even when oracle stays green');
    check((await h.board()).protocol.gatePasses.length === 0, 'U3 no credential certifies a candidate unseen by final reviewer');
  });
  await scenario('unbound historical review', async h => {
    await h.edit(t => { t.protocol.cycles[0].step = 'VERIFIED'; t.protocol.cycles[0].verify = { verdict: 'accept', computed: true, evidence: ['legacy receipt'] }; });
    const response = await resultOf(h.call('pair_gate_check', { task_id: 't-1' }, 'cap'));
    check(response.error?.includes('STALE') || response.value?.failures?.some(text => text.includes('review')), 'U3 historical review lacking a candidate binding cannot silently certify current code');
  });
  await scenario('two defect re-forks', async h => {
    await h.verify(veto);
    await writeFile(join(h.root, 'product.txt'), 'broken');
    await writeFile(join(h.root, oracleFile), oracleText + '// first correction\n');
    await h.call('pair_oracle', { task_id: 't-1', ...fork, fork_kind: 'defect', defect_evidence: 'prior oracle omitted empty-value regression' });
    const second = await h.call('pair_propose', { task_id: 't-1', intent: 'first repair', files: ['product.txt'], net_lines: 1, verify_plan: command }, 'drv');
    await h.call('pair_green', { cycle_id: second.cycle_id, green_evidence: ['reported'], diff_summary: 'first repair', test_results: 'reported', tuned_for_oracle: 'none' }, 'drv');
    await h.call('pair_verify', { cycle_id: second.cycle_id });
    await writeFile(join(h.root, oracleFile), oracleText + '// second correction\n');
    await h.call('pair_oracle', { task_id: 't-1', ...fork, fork_kind: 'defect', defect_evidence: 'second oracle omitted whitespace-value regression' });
    const third = await h.call('pair_propose', { task_id: 't-1', intent: 'final repair', files: ['product.txt'], net_lines: 1, verify_plan: command }, 'drv');
    await writeFile(join(h.root, 'product.txt'), 'ok');
    await h.call('pair_green', { cycle_id: third.cycle_id, green_evidence: ['real green'], diff_summary: 'final repair', test_results: 'real green', tuned_for_oracle: 'none' }, 'drv');
    await h.call('pair_verify', { cycle_id: third.cycle_id, ...scope });
    const gate = await h.call('pair_gate_check', { task_id: 't-1' }, 'cap');
    check(gate.pass && gate.checklist.supersededRejectedCycles.length === 2, 'U3 re-fork ancestry preserves both audited rejected closures across two replacement seals');
    const tampered = await h.board(); delete tampered.protocol.cycles[0].closure;
    check(!runGate(tampered, 't-1', { dod: ['all_accepted'] }).pass, 'U3 arbitrary CLOSED rejection without matching closure audit remains unsettled');
  });
  await scenario('cancelled running review', async h => {
    const rendez = await rendezvous(h); await h.edit(t => { t.tasks[0].oracle.cmd = rendez.command; });
    const controller = new AbortController();
    const pending = resultOf(h.verify({}, controller.signal));
    await rendez.entered(); controller.abort(); await rendez.release();
    check((await pending).error?.includes('CANCELLED'), 'U3 cancellation during command cannot commit review evidence');
    check((await h.board()).protocol.cycles[0].verify === undefined, 'U3 cancelled in-flight review leaves verdict absent');
  });
  await scenario('freeze race', async h => {
    await h.edit(t => { t.protocol.cycles = []; delete t.tasks[0].oracle; });
    const rendez = await rendezvous(h);
    const pending = resultOf(h.call('pair_oracle', { task_id: 't-1', ...fork, oracle_cmd: `${rendez.command} && node -e "process.exit(1)"` }));
    await rendez.entered(); await h.edit(t => { t.tasks[0].attemptId = 'different-attempt'; }); await rendez.release();
    check((await pending).error?.includes('STALE'), 'U3 freeze refuses a changed task attempt during RED');
    check((await h.board()).tasks[0].oracle === undefined, 'U3 stale RED freezes no oracle');
  });
  await scenario('gate credential attempt ownership', async h => {
    await h.verify();
    const gate = await h.call('pair_gate_check', { task_id: 't-1' }, 'cap');
    await h.edit(t => { t.tasks[0].attemptId = 'new-attempt'; t.tasks[0].handoffId = 'new-handoff'; });
    const completion = await resultOf(h.call('pair_task_update', { task_id: 't-1', status: 'completed', attempt_id: 'new-attempt', gate_pass_id: gate.gate_pass_id }, 'drv'));
    check(completion.error?.includes('GATE_STALE'), 'U3 a reassigned attempt cannot redeem the prior attempt gate credential');
    check((await h.board()).tasks[0].status === 'in_progress', 'U3 stale gate ownership cannot complete the new attempt');
  });
  await scenario('self-mutating DoD cache', async h => {
    // K2-4: pinned against the developer's git config, and bounded.
  const GIT_PINS = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', '-c', 'core.pager=cat', '-c', 'advice.detachedHead=false'];
  const git = args => execFileP('git', [...GIT_PINS, ...args], { cwd: h.root, timeout: 60_000 });
    await git(['init']); await git(['config', 'user.name', 'Verification Fixture']); await git(['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(join(h.root, '.gitignore'), '.state/\n');
    await git(['add', '.']); await git(['commit', '-m', 'cache candidate']);
    await h.verify();
    check((await resultOf(h.call('pair_gate_check', { task_id: 't-1' }, 'cap'))).error?.includes('STALE'), 'U3 self-mutating cached DoD first run is stale');
    await writeFile(join(h.root, 'product.txt'), 'ok');
    check((await resultOf(h.call('pair_gate_check', { task_id: 't-1' }, 'cap'))).error?.includes('STALE'), 'U3 self-mutating DoD cannot seed a passing cache receipt for restored code');
  }, { evidenceCache: true, dodCommand: `node -e "require('fs').writeFileSync('product.txt','mutated')"` });
}

/**
 * Closure of a multi-task board, measured live: completing one task binds its
 * credential to the worktree of that moment, the NEXT task's implementation
 * moves the tree, and pair_stop then demands a credential bound to the final
 * tree. Its refusal says 're-run pair_gate_check' — so the gate must accept a
 * completed task, or the instruction names a call the runtime rejects and no
 * board with two tasks can ever be stopped as complete.
 */
export async function runClosureRegression(check) {
  const h = await fixture();
  try {
    await h.verify();
    const first = await h.call('pair_gate_check', { task_id: 't-1' }, 'cap');
    check(first.pass === true, 'closure the first gate pass is issued while the task is still in flight');
    await h.edit(t => { t.tasks[0].status = 'completed'; t.tasks[0].attemptId = undefined; });
    // What a later task on the same board does: it changes the tree.
    await writeFile(join(h.root, 'later-task.txt'), 'a second task shipped its own file');
    const finalTree = await workspaceFingerprint(h.root, { stateDir: '.state' });
    const stale = completionReadiness(await h.board(), { greenRequired: false, worktreeSha: finalTree }).failures;
    check(stale.some(text => text.includes('stale against the final worktree')), 'closure the completed task holds a credential stale against the final worktree');
    const again = await resultOf(h.call('pair_gate_check', { task_id: 't-1' }, 'cap'));
    check(again.error === undefined, `closure the gate re-runs for a completed task instead of refusing it (${again.error ?? 'ok'})`);
    check(again.value?.pass === true && again.value.gate_pass_id !== first.gate_pass_id, 'closure the re-gate issues a fresh credential bound to the final worktree');
    const after = completionReadiness(await h.board(), { greenRequired: false, worktreeSha: finalTree }).failures;
    check(!after.some(text => text.includes('stale against the final worktree')), 'closure re-gating clears the only obstacle pair_stop named');
    await h.edit(t => { t.tasks[0].status = 'cancelled'; });
    check((await resultOf(h.call('pair_gate_check', { task_id: 't-1' }, 'cap'))).error?.includes('terminal'), 'closure a cancelled task is still refused — completed is the only terminal status the gate certifies');
    check((await h.board()).protocol.gatePasses.at(-1).recertified === true, 'closure the re-issued credential records that it was re-certified, not freshly reviewed');
    // pair_stop requires RETRO before it will close a board, and then asks for a
    // current credential. A gate that refuses in RETRO refuses in the only phase
    // where a successful stop can happen.
    await h.edit(t => { t.tasks[0].status = 'completed'; t.protocol.phase = 'RETRO'; });
    await writeFile(join(h.root, 'retro-note.txt'), 'the tree moves once more');
    const inRetro = await resultOf(h.call('pair_gate_check', { task_id: 't-1' }, 'cap'));
    check(inRetro.value?.pass === true, `closure the gate still certifies in RETRO, the phase pair_stop requires (${inRetro.error ?? 'ok'})`);
    for (const phase of ['DONE', 'ABORTED']) {
      await h.edit(t => { t.protocol.phase = phase; });
      check((await resultOf(h.call('pair_gate_check', { task_id: 't-1' }, 'cap'))).error?.includes('team is closed'), `closure a ${phase} board issues no further credentials`);
    }
    await h.edit(t => { t.protocol.phase = 'EXECUTION'; });
  } finally { await h.cleanup(); }

  // The knot that closed on itself live: the captain settled the impasse the
  // documented way, and its ruling was part of the fingerprint that decides
  // whether the review still stands.
  const ruled = await fixture();
  try {
    await ruled.verify();
    await ruled.call('pair_gate_check', { task_id: 't-1' }, 'cap');
    await ruled.edit(t => { t.tasks[0].status = 'completed'; t.tasks[0].attemptId = undefined; });
    await writeFile(join(ruled.root, 'later-task.txt'), 'a second task shipped its own file');
    await ruled.edit(t => { t.protocol.phase = 'RETRO'; });
    await ruled.call('pair_arbitrate', { conflict_ref: 't-1 gate stale after t-2 edit', decision: 're-certify t-1 against the final tree', evidence: ['src/range.mjs:1'], rationale: 'a later task moved the tree this credential was bound to' }, 'cap');
    const re = await resultOf(ruled.call('pair_gate_check', { task_id: 't-1' }, 'cap'));
    check(re.value?.pass === true, `closure a ruling about the stale gate does not tighten it (${re.error ?? 'ok'})`);
    const tree = await workspaceFingerprint(ruled.root, { stateDir: '.state' });
    const left = completionReadiness(await ruled.board(), { greenRequired: false, worktreeSha: tree }).failures;
    check(!left.some(text => text.includes('stale')), `closure no credential is left stale for pair_stop to refuse (${left.join(' | ')})`);
  } finally { await ruled.cleanup(); }

  // The pointer can be gone while the pass it named is still on the board. That is
  // the live state this was reported from: a failed gate erased task.gatePassId,
  // after which pair_gate_check refused the task forever and pair_stop refused the
  // closure — a completed, fully verified board that could not be recorded DONE for
  // a missing convenience field.
  const erased = await fixture();
  try {
    await erased.verify();
    const live = await erased.call('pair_gate_check', { task_id: 't-1' }, 'cap');
    await erased.edit(t => { t.tasks[0].status = 'completed'; t.tasks[0].attemptId = undefined; t.tasks[0].gatePassId = undefined; });
    await writeFile(join(erased.root, 'later-task.txt'), 'a second task shipped its own file');
    const erasedTree = await workspaceFingerprint(erased.root, { stateDir: '.state' });
    const erasedFailures = completionReadiness(await erased.board(), { greenRequired: false, worktreeSha: erasedTree }).failures;
    check(!erasedFailures.some(text => text.includes('lack their exact gate credential')),
      `closure a completed task whose pass is live is not refused for a pointer that is not there (${erasedFailures.join(' | ')})`);
    check(erasedFailures.some(text => text.includes('stale against the final worktree')),
      'closure and it is still refused for the reason that matters: the credential is stale against the tree');
    const reErased = await resultOf(erased.call('pair_gate_check', { task_id: 't-1' }, 'cap'));
    check(reErased.value?.pass === true,
      `closure the gate re-certifies a completed task whose pointer was erased (${reErased.error ?? 'ok'})`);
    check(reErased.value?.gate_pass_id !== live.gate_pass_id,
      'closure and it mints a fresh credential rather than reusing the one from before the tree moved');
  } finally { await erased.cleanup(); }

  // A failed gate erases the credential ONLY when the product is what failed. A
  // blocking risk is a board condition the next gate re-derives, and it must not
  // destroy the pointer the completed-task re-certification chain depends on.
  const blocked = await fixture();
  try {
    await blocked.verify();
    const held = await blocked.call('pair_gate_check', { task_id: 't-1' }, 'cap');
    await blocked.edit(t => { t.tasks[0].status = 'completed'; t.tasks[0].attemptId = undefined; });
    // A card whose tracked criteria and executable oracle cases no longer line up:
    // a PROCESS failure, while the frozen oracle itself still replays green.
    await blocked.edit(t => { t.tasks[0].acceptanceRefs = ['UC-9.AC-9']; });
    const refused = await resultOf(blocked.call('pair_gate_check', { task_id: 't-1' }, 'cap'));
    check(refused.value?.pass === false, 'closure a card whose criteria lose their executable oracle cases is refused by the gate');
    const afterProcessFailure = await blocked.board();
    check(afterProcessFailure.tasks[0].gatePassId === held.gate_pass_id,
      'closure and that process refusal does not destroy the credential the task was holding');
  } finally { await blocked.cleanup(); }
  // What re-certification must NOT buy. Each of these moves one dimension the
  // allowance deliberately does not cover.
  const denied = {
    "a later change that breaks the completed task's own oracle": async f => { await writeFile(join(f.root, 'product.txt'), 'broken by the next task'); },
    'a task that was never completed on its own credential': async f => { await f.edit(t => { t.tasks[0].status = 'in_progress'; }); },
    'a credential issued for a different attempt than the review signed': async f => { await f.edit(t => { t.protocol.gatePasses.at(-1).binding.taskAttempt.attemptId = 'attempt-2'; }); },
  };
  for (const [name, drift] of Object.entries(denied)) {
    const f = await fixture();
    try {
      await f.verify();
      await f.call('pair_gate_check', { task_id: 't-1' }, 'cap');
      await f.edit(t => { t.tasks[0].status = 'completed'; t.tasks[0].attemptId = undefined; });
      await writeFile(join(f.root, 'later-task.txt'), 'a second task shipped its own file');
      await drift(f);
      const result = await resultOf(f.call('pair_gate_check', { task_id: 't-1' }, 'cap'));
      check(result.error !== undefined || result.value?.pass === false, `closure re-certification refuses ${name}`);
    } finally { await f.cleanup(); }
  }
}
/** Recovery sequences discovered by independent review of the evidence boundary. */
export async function runReviewRegressions(check) {
  const h = await fixture();
  try {
    await h.verify({ stage: 'checkpoint' });
    const originalCheckpoint = (await h.board()).protocol.cycles[0].verify;
    const second = await h.call('pair_propose', { task_id: 't-1', intent: 'final increment', files: ['product.txt'], verify_plan: command, net_lines: 1 }, 'drv');
    await h.call('pair_green', { cycle_id: second.cycle_id, green_evidence: ['green'], diff_summary: 'final increment', test_results: 'green', tuned_for_oracle: 'none' }, 'drv');
    await h.call('pair_verify', { cycle_id: second.cycle_id, ...veto });
    await h.call('pair_oracle_write', { task_id: 't-1', path: oracleFile, content: "import { readFileSync } from 'node:fs'; process.exit(readFileSync('product.txt','utf8') === 'ok-new' ? 0 : 1);\n" });
    await h.call('pair_oracle', { task_id: 't-1', ...fork, fork_kind: 'defect', defect_evidence: 'Prior oracle omitted the output suffix requirement.' });
    let board = await h.board();
    check(board.protocol.cycles[0].closure?.reason === 'oracle-replaced' && board.protocol.cycles[0].step === 'CLOSED', 'checkpoint re-fork explicitly archives superseded checkpoint');
    check(JSON.stringify(board.protocol.cycles[0].verify) === JSON.stringify(originalCheckpoint), 'checkpoint re-fork preserves original partial verification evidence');
    check(!runGate(board, 't-1', { dod: ['all_accepted'] }).pass, 'superseded checkpoint and rejection cannot replace final acceptance');
    const repair = await h.call('pair_propose', { task_id: 't-1', intent: 'repair replacement contract', files: ['product.txt'], verify_plan: command, net_lines: 1 }, 'drv');
    await writeFile(join(h.root, 'product.txt'), 'ok-new');
    await h.call('pair_green', { cycle_id: repair.cycle_id, green_evidence: ['real green'], diff_summary: 'replacement repair', test_results: 'green', tuned_for_oracle: 'none' }, 'drv');
    await h.call('pair_verify', { cycle_id: repair.cycle_id, ...scope });
    const gate = await h.call('pair_gate_check', { task_id: 't-1' }, 'cap');
    check(gate.pass === true, 'checkpoint -> reject -> defect re-fork -> fresh final review reaches gate');
    board = await h.board();
    const noAudit = structuredClone(board); delete noAudit.protocol.cycles[0].closure;
    check(!runGate(noAudit, 't-1', { dod: ['oracle_precedes_impl'] }).pass, 'old checkpoint without matching supersession audit cannot waive oracle ordering');
    const badHistory = structuredClone(board); delete badHistory.protocol.cycles[0].red;
    check(!runGate(badHistory, 't-1', { dod: ['test_first'], tddMode: 'enforce' }).pass, 'superseded checkpoint retains Test First obligations');
  } finally { await h.cleanup(); }

  for (const stage of ['checkpoint', 'final']) {
    const f = await fixture();
    try {
      const benignOutput = `${command} && node -e "console.log('negative-path test handled: No such file or directory')"`;
      await f.edit(t => { t.tasks[0].oracle.cmd = benignOutput; t.protocol.cycles[0].proposal.verify_plan = benignOutput; });
      const result = await resultOf(f.verify({ stage }));
      check(result.value?.verdict === (stage === 'final' ? 'accept' : 'checkpoint'), `passing ${stage} output mentioning an expected failure is not infrastructure failure`);
    } finally { await f.cleanup(); }
  }
}

export async function runDirectoryRecovery(check) {
  const h=await fixture();
  try {
    await mkdir(join(h.root,'deliverables/nested'),{recursive:true});
    await writeFile(join(h.root,'deliverables/nested/architecture.txt'),'reviewed architecture');
    await h.edit(t=>{
      t.tasks[0].deliverables=['deliverables/'];
      t.tasks.push({id:'t-2',subject:'import',status:'pending',dependencies:['t-1'],createdAt:2,updatedAt:2});
    });
    await h.verify();
    const before=await h.board();
    check(oraclePreparationWindow(before,'t-2').future, 'unfinished directory task blocks future oracle before gate');
    const gate=await h.call('pair_gate_check',{task_id:'t-1'},'cap');
    check(gate.pass===true && gate.deliverables.checked.some(v=>v.includes('directory')), 'accepted directory deliverable gets real gate credential');
    await h.call('pair_task_update',{task_id:'t-1',status:'completed',attempt_id:'attempt-1',gate_pass_id:gate.gate_pass_id},'drv');
    const after=await h.board();
    check(after.tasks[0].status==='completed' && !oraclePreparationWindow(after,'t-2').future, 'normal completion unlocks next oracle without dropping dependency');
    check(JSON.stringify(before.protocol.cycles)===JSON.stringify(after.protocol.cycles) && JSON.stringify(before.tasks[0].deliverables)===JSON.stringify(after.tasks[0].deliverables), 'directory recovery preserves accepted cycles and frozen delivery declaration');
  } catch(error) {check(false,'directory recovery: '+error.stack);}
  finally {await h.cleanup();}
}
