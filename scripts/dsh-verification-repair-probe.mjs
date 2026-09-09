/** Deterministic native DSH tool-pipeline probe, not a model-behavior benchmark.
 * Seeds a minimal board with real Agent identities, then uses registered tools
 * for RED freeze, proposal, failed checkpoint, repair and fresh final acceptance.
 * Files are disposable fixture inputs; no live user board is read or modified.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { Config } from '@deepseek-ai/dsh-headless';
import { initialProtocolState } from '../lib/protocol/machine.js';
import { createTeamDir, readTeam, writeTeam } from '../lib/state/store.js';
export { Config };
export const name = 'pair-native-repair-probe';
export const inject = ['agents', 'sessions', 'tools', 'headlessStartup'];
export function apply(ctx) {
  run(ctx).then(() => ctx.get('appExit')(0), error => {
    process.stderr.write(String(error.stack) + '\n'); ctx.get('appExit')(1);
  });
}
async function run(ctx) {
  await ctx.get('loader')?.await();
  const output = process.env.DSH_PAIR_SMOKE_OUTPUT;
  assert.ok(output, 'DSH_PAIR_SMOKE_OUTPUT required');
  const selection = { provider: 'opencode-go-muse', model: 'muse-spark-1.3-contributor' };
  const receipt = { kind: 'native-tool-pipeline; no model turns', selection, startedAt: new Date().toISOString(), calls: [] };
  const handles = [];
  const stateRoot = join(process.cwd(), '.pair-programming');
  let team;
  const timer = setTimeout(() => ctx.get('appExit')(1), 120000);
  try {
    for (let i = 0; i < 2; i++) handles.push(await ctx.agents.create({ sessionId: 'session-' + randomUUID(),
      meta: { cwd: process.cwd() }, agentOptions: selection,
      setup: child => { installModelSelection(child, { current: selection, assembled: undefined }); } }));
    const captain = handles[0].agent, spec = handles[1].agent;
    team = { id: 'native-repair', name: 'native-repair', mode: 'solo', goal: 'Fixture consumer receives contract value 1',
      captainSessionId: captain.id, tddMode: 'enforce', createdAt: Date.now(), updatedAt: Date.now(), taskSeq: 1,
      protocol: initialProtocolState(), members: [{ id: spec.id, name: 'spec', role: 'spec', status: 'idle', joinedAt: Date.now() }],
      tasks: [{ id: 't-1', subject: 'Return the required contract value', status: 'in_progress', assignee: 'captain',
        attemptId: randomUUID(), createdAt: Date.now(), updatedAt: Date.now(), dependencies: [] }] };
    await createTeamDir(stateRoot, team);
    const invoke = async (name, args, agent = captain, expectedFailure = false) => {
      const result = await ctx.tools.execute({ name, arguments: args, agent, callId: 'probe-' + randomUUID(), signal: new AbortController().signal });
      receipt.calls.push({ name, isError: result.isError, value: result.value ?? null, error: result.error ?? null });
      if (expectedFailure) { assert.equal(result.isError, true); return result; }
      if (result.isError) throw new Error(name + ': ' + JSON.stringify(result.error));
      return result.value;
    };
    const file = '.pair-oracles/t-1/accept.cjs', command = 'node ' + file;
    await invoke('pair_oracle_write', { task_id: 't-1', path: file,
      content: "require('node:assert').strictEqual(require('../../contract.cjs'),1);" }, spec);
    const frozen = await invoke('pair_oracle', { task_id: 't-1', readings: ['Contract consumer receives numeric one', 'Contract consumer receives string one'],
      chosen_reading: 'Contract consumer receives numeric one', divergence_candidates: ['Numeric and string consumers disagree on strict equality'],
      oracle_files: [file], oracle_cmd: command, expected_failure: 'baseline exports zero' }, spec);
    const broken = 'node -e "require("node:assert").equal(1,1)"';
    const proposal = await invoke('pair_propose', { task_id: 't-1', intent: 'Return required numeric value', files: ['contract.cjs'],
      verify_plan: broken, net_lines: 1, acceptance_criteria_ref: 'Numeric contract is one', uncertainty: 'none' });
    const cycleId = proposal.cycle_id;
    await writeFile(join(process.cwd(), 'contract.cjs'), 'module.exports = 1;\n');
    const green = { cycle_id: cycleId, green_evidence: ['fixture now exports numeric one'], diff_summary: 'contract.cjs changes zero to one',
      test_results: command, tuned_for_oracle: 'none' };
    await invoke('pair_green', green);
    const failed = await invoke('pair_verify', { cycle_id: cycleId, stage: 'checkpoint' });
    assert.equal(failed.verdict, 'reject');
    const before = await readTeam(stateRoot, team.id);
    await invoke('pair_repair_verify_plan', { cycle_id: cycleId, verify_plan: command,
      reason: 'Nested inline quotes fail on Windows while the unchanged script command is executable',
      evidence: ['Native checkpoint returned ' + failed.category, 'Final oracle files and acceptance standard are unchanged'] });
    const repaired = await readTeam(stateRoot, team.id);
    assert.deepEqual(repaired.tasks[0].oracle, before.tasks[0].oracle);
    assert.equal(repaired.protocol.cycles[0].rejections, before.protocol.cycles[0].rejections);
    assert.deepEqual(repaired.protocol.stats, before.protocol.stats);
    assert.equal(repaired.protocol.cycles.length, 1);
    assert.equal(repaired.protocol.cycles[0].verificationRepairs.length, 1);
    await invoke('pair_verify', { cycle_id: cycleId, stage: 'final' }, captain, true);
    await invoke('pair_green', green);
    assert.equal((await invoke('pair_verify', { cycle_id: cycleId, stage: 'checkpoint' })).verdict, 'checkpoint');
    const final = await invoke('pair_verify', { cycle_id: cycleId, stage: 'final', beyond_request: 'nothing', preexisting_at_risk: 'numeric consumer contract recomputed' });
    assert.equal(final.verdict, 'accept');
    receipt.status = 'passed'; receipt.oracleSha = frozen.oracle_sha;
    receipt.cycle = (await readTeam(stateRoot, team.id)).protocol.cycles[0];
  } finally {
    clearTimeout(timer);
    if (team) {
      const board = await readTeam(stateRoot, team.id);
      board.protocol.phase = 'ABORTED';
      for (const member of board.members) member.status = 'removed';
      await writeTeam(stateRoot, board);
    }
    await Promise.allSettled(handles.map(handle => handle.dispose()));
    receipt.endedAt = new Date().toISOString();
    await writeFile(output, JSON.stringify(receipt, null, 2));
  }
  process.stdout.write('NATIVE_REPAIR_PROBE passed\n');
}
