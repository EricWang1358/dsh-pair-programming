import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerRepairTools } from '../lib/tools/repair.js';
import { registerFlowTools } from '../lib/tools/flow.js';
import { createTeamDir, readTeam, writeTeam } from '../lib/state/store.js';
import { readMailbox } from '../lib/state/mailbox.js';
import { initialProtocolState, openCycle } from '../lib/protocol/machine.js';
import { digestOracleFiles, runOracleCommand } from '../lib/tools/oracle-exec.js';

const execute = promisify(execFile);
const BROKEN = 'node -e "require("node:assert").equal(1,1)"';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pair-repair-'));
  await execute('git', ['init'], { cwd: root });
  await writeFile(join(root, 'contract.cjs'), 'module.exports = 0;');
  await execute('git', ['add', '.'], { cwd: root });
  await execute('git', ['-c', 'user.name=Repair test', '-c', 'user.email=repair@test.invalid', 'commit', '-m', 'base'], { cwd: root });
  const file = '.pair-oracles/t-1/accept.cjs';
  await mkdir(join(root, '.pair-oracles/t-1'), { recursive: true });
  await writeFile(join(root, file), "require('assert').equal(require('../../contract.cjs'),1);");
  const command = 'node ' + file;
  assert.notEqual((await runOracleCommand(root, command)).exit, 0);
  const oracle = { cmd: command, files: [file], sha: await digestOracleFiles(root, [file]), frozenAt: 1, redExit: 1 };
  const protocol = initialProtocolState(); protocol.phase = 'CYCLING';
  const cycle = openCycle(protocol, 't-1', { tddMode: 'enforce', oracleSha: oracle.sha });
  Object.assign(cycle, { step: 'GREEN', proposal: { intent: 'fix contract', files: ['contract.cjs'], verify_plan: BROKEN },
    review: { verdict: 'go', auto: true, at: 1 }, red: { evidence: ['baseline contract fails'], at: 1 },
    green: { evidence: ['contract repaired'], at: 2 }, report: { diff_summary: 'contract.cjs', test_results: command, at: 2 }, rejections: 2 });
  protocol.stats.reject = 2;
  const team = { id: 'repair', name: 'repair', goal: 'repair checkpoint transport', captainSessionId: 'cap', mode: 'light', tddMode: 'enforce',
    createdAt: 1, updatedAt: 1, taskSeq: 1, protocol, members: [
      { id: 'driver', name: 'driver', role: 'driver', status: 'idle', joinedAt: 1 },
      { id: 'nav', name: 'navigator', role: 'navigator', status: 'idle', joinedAt: 1 }],
    tasks: [{ id: 't-1', subject: 'contract', dependencies: [], status: 'in_progress', assignee: 'driver', attemptId: 'attempt', oracle, createdAt: 1, updatedAt: 1 }] };
  await writeFile(join(root, 'contract.cjs'), 'module.exports = 1;');
  const stateRoot = join(root, '.pair-programming'); await createTeamDir(stateRoot, team);
  const defs = [], kicks = [];
  const ctx = { tools: { register: d => defs.push(d) }, agents: { get: () => undefined }, logger: { debug() {}, warn() {}, error() {} } };
  const runtime = { scheduler: { kickTeam: async () => kicks.push(await readTeam(stateRoot, team.id)) } };
  const config = { stateDir: '.pair-programming', evidenceCache: false, tddMode: 'enforce', oracleFirst: true, maxCyclesPerTask: 1 };
  registerFlowTools(ctx, config, runtime); registerRepairTools(ctx, config, runtime);
  const args = { cycle_id: cycle.id, verify_plan: command, reason: 'Windows nested inline quotes corrupted the command', evidence: ['node -e emits SyntaxError while the same assertion in the frozen script passes'] };
  return { root, stateRoot, args, cycle, kicks, runtime,
    call: (name, parameters, id = 'nav') => defs.find(d => d.name === name).execute(parameters, { agent: { id, session: { header: { cwd: root }, append() {} } } }),
    board: () => readTeam(stateRoot, team.id),
    edit: async fn => { const t = await readTeam(stateRoot, team.id); fn(t); await writeTeam(stateRoot, t); },
    green: () => ({ cycle_id: cycle.id, green_evidence: ['fresh script exit 0'], diff_summary: 'contract.cjs', test_results: command, tuned_for_oracle: 'none' }),
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}
export async function run(check) {
  const scenario = async (name, fn) => { const h = await fixture(); try { await fn(h); check(true, name); } catch (e) { check(false, name + ': ' + e.stack); } finally { await h.cleanup(); } };
  await scenario('broken inline checkpoint can be repaired without a fork or budget reset, then reverified', async h => {
    const failure = await h.call('pair_verify', { cycle_id: h.cycle.id, stage: 'checkpoint' });
    assert.equal(failure.verdict, 'reject');
    await h.edit(t => { t.tasks[0].gatePassId = 'old-pass'; t.protocol.gatePasses.push({ id: 'old-pass', taskId: 't-1' }); });
    const before = await h.board();
    const result = await h.call('pair_repair_verify_plan', h.args);
    const after = await h.board(), cycle = after.protocol.cycles[0], old = before.protocol.cycles[0];
    assert.equal(result.step, 'GO'); assert.equal(cycle.green, undefined); assert.equal(cycle.report, undefined); assert.equal(cycle.verify, undefined);
    assert.deepEqual(cycle.red, old.red); assert.deepEqual(cycle.review, old.review); assert.equal(cycle.oracleSha, old.oracleSha);
    assert.equal(cycle.rejections, old.rejections); assert.deepEqual(after.protocol.stats, before.protocol.stats);
    assert.deepEqual(after.tasks[0].oracle, before.tasks[0].oracle); assert.equal(after.tasks[0].gatePassId, undefined);
    assert.deepEqual(after.protocol.gatePasses, before.protocol.gatePasses); assert.equal(after.protocol.cycles.length, 1);
    assert.deepEqual(cycle.verificationRepairs[0].previous.verify, old.verify);
    assert.equal(cycle.verificationRepairs[0].from, BROKEN); assert.equal(cycle.proposal.intent, old.proposal.intent);
    assert.deepEqual(cycle.proposal.files, old.proposal.files);
    assert.ok((await readMailbox(h.stateRoot, 'repair', 'driver')).some(m => m.content.includes('fresh GREEN')));
    assert.equal(h.kicks.at(-1).protocol.cycles[0].step, 'GO');
    await assert.rejects(h.call('pair_verify', { cycle_id: h.cycle.id, stage: 'checkpoint' }), /GREEN|GO/);
    await h.call('pair_green', h.green(), 'driver');
    assert.equal((await h.call('pair_verify', { cycle_id: h.cycle.id, stage: 'checkpoint' })).verdict, 'checkpoint');
    assert.equal((await h.call('pair_verify', { cycle_id: h.cycle.id, stage: 'final', beyond_request: 'nothing', preexisting_at_risk: 'baseline contract checked' })).verdict, 'accept');
  });
  await scenario('a complete candidate already has a legitimate full-oracle path despite broken verify_plan', async h => {
    assert.equal((await h.call('pair_verify', { cycle_id: h.cycle.id, stage: 'final', beyond_request: 'nothing', preexisting_at_risk: 'baseline contract checked' })).verdict, 'accept');
    await assert.rejects(h.call('pair_repair_verify_plan', h.args), /immutable|completed/);
  });
  await scenario('Driver cannot repair its own checkpoint; Captain can authorize without fabricating GO', async h => {
    await assert.rejects(h.call('pair_repair_verify_plan', h.args, 'driver'), /Navigator|captain/);
    await h.edit(t => { t.protocol.cycles[0].review = { verdict: 'no_go', at: 2 }; });
    assert.equal((await h.call('pair_repair_verify_plan', h.args, 'cap')).step, 'PROPOSED');
    const board = await h.board(); assert.equal(board.protocol.cycles[0].review.verdict, 'no_go');
    assert.equal(board.protocol.cycles[0].verificationRepairs[0].by, 'captain');
  });
  await scenario('unchanged commands, missing evidence and malformed replacement plans are mutation-free refusals', async h => {
    const before = await h.board();
    for (const override of [{ verify_plan: BROKEN }, { reason: ' ' }, { evidence: [] }, { evidence: [' '] },
      { verify_plan: '1) npm test must pass' }, { verify_plan: 'node a.cjs\nnode b.cjs' }]) {
      await assert.rejects(h.call('pair_repair_verify_plan', { ...h.args, ...override }));
      assert.deepEqual(await h.board(), before);
    }
  });
  await scenario('missing, changed or tampered frozen oracles cannot be repaired around', async h => {
    const original = await h.board();
    for (const change of [t => { delete t.tasks[0].oracle; }, t => { delete t.protocol.cycles[0].oracleSha; },
      t => { t.tasks[0].oracle.sha = 'other'; }]) {
      await writeTeam(h.stateRoot, structuredClone(original)); await h.edit(change);
      await assert.rejects(h.call('pair_repair_verify_plan', h.args), /oracle|frozen/);
    }
    await writeTeam(h.stateRoot, original);
    await writeFile(join(h.root, original.tasks[0].oracle.files[0]), 'process.exit(0);');
    await assert.rejects(h.call('pair_repair_verify_plan', h.args), /oracle|digest/);
  });
  await scenario('closed, superseded, terminal and inactive-seat targets refuse repair', async h => {
    const original = await h.board();
    for (const change of [t => { t.protocol.cycles[0].step = 'CLOSED'; }, t => { openCycle(t.protocol, 't-1'); },
      t => { t.tasks[0].status = 'completed'; }, t => { t.tasks[0].status = 'pending'; },
      t => { t.protocol.phase = 'ABORTED'; }, t => { t.members[1].status = 'removed'; }]) {
      await writeTeam(h.stateRoot, structuredClone(original)); await h.edit(change);
      await assert.rejects(h.call('pair_repair_verify_plan', h.args));
    }
  });
  await scenario('solo Captain retains repair authority while the SPEC seat cannot repair', async h => {
    await h.edit(t => { t.mode = 'solo'; t.members = [{ id: 'nav', name: 'spec', role: 'spec', status: 'idle', joinedAt: 1 }]; t.tasks[0].assignee = 'captain'; });
    await assert.rejects(h.call('pair_repair_verify_plan', h.args), /captain|Navigator/);
    const result = await h.call('pair_repair_verify_plan', h.args, 'cap');
    assert.equal(result.step, 'GO'); assert.equal(result.delivered, 'current-caller');
    assert.match(result.you_owe_next, /fresh GREEN/);
    assert.equal((await readMailbox(h.stateRoot, 'repair', 'driver')).length, 0);
    assert.equal((await readMailbox(h.stateRoot, 'repair', 'captain')).length, 0);
  });
  await scenario('a failed scheduler wake cannot reject or discard a committed repair', async h => {
    h.runtime.scheduler.kickTeam = async () => { throw new Error('wake unavailable'); };
    const result = await h.call('pair_repair_verify_plan', h.args);
    assert.equal(result.step, 'GO'); assert.equal((await h.board()).protocol.cycles[0].verificationRepairs.length, 1);
  });
}
