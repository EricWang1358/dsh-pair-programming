import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBacklogTools } from '../lib/tools/backlog.js';
import { registerTaskTools } from '../lib/tools/task.js';
import { registerFlowTools } from '../lib/tools/flow.js';
import { registerOracleTools } from '../lib/tools/oracle.js';
import { registerLifecycleTools } from '../lib/tools/lifecycle.js';
import { initialProtocolState } from '../lib/protocol/machine.js';
import { obligationFrontier } from '../lib/protocol/obligation.js';
import { completionReadiness } from '../lib/protocol/completion.js';
import { createTeamDir, readTeam, writeTeam } from '../lib/state/store.js';
import { readMailbox } from '../lib/state/mailbox.js';

const discoveryArgs = (extra = {}) => ({ action: 'discover', observation: 'Import recovery loses the source filename', user_value: 'Support staff can diagnose failed uploads without opening logs', evidence: ['src/import.mjs:42 error omits filename'], acceptance_criteria: ['Rejected uploads identify their source filename'], scope: 'within_goal', ...extra });
const cardArgs = (extra = {}) => ({ subject: 'Explain rejected imports', role: 'support operator', intent: 'identify which import was rejected', benefit: 'reduce incident investigation time', acceptance_criteria: discoveryArgs().acceptance_criteria, write_paths: ['src/import.mjs'], read_paths: [], resources: [], ...extra });
const triageArgs = (discovery, extra = {}) => ({ action: 'triage', discovery_id: discovery.id, decision: 'later', priority: 2, rationale: 'Useful recovery increment after the current commitment', ...extra });

async function harness(root, parallel = false) {
  await mkdir(root, { recursive: true });
  const defs = new Map();
  const stateRoot = join(root, 'state');
  const team = { id: 'backlog', name: 'backlog', goal: 'reliable import recovery', mode: 'light', tddMode: 'enforce', pairStyle: 'traditional', captainSessionId: 'cap', createdAt: 1, updatedAt: 1, taskSeq: 0, tasks: [],
    members: [{ id: 'driver-id', name: 'driver', role: 'driver', status: 'idle' }, { id: 'driver2-id', name: 'driver2', role: 'driver', status: 'idle' }, { id: 'nav-id', name: 'navigator', role: 'navigator', status: 'idle' }], protocol: initialProtocolState(), evidenceStats: { cacheHits: 0, cacheMiss: 0 },
    ...(parallel ? { parallel: { slots: { driver: { path: join(root, 'driver') }, driver2: { path: join(root, 'driver2') } } } } : {}),
  };
  for (const member of team.members) member.joinedAt = 1;
  team.protocol.phase = 'PLANNING';
  await createTeamDir(stateRoot, team);
  const ctx = { tools: { register: tool => defs.set(tool.name, tool) }, logger: { warn() {}, debug() {}, error() {} }, agents: { get() {} }, subagents: { sendMessage: async () => 'message' } };
  const config = { stateDir: 'state', tddMode: 'enforce', oracleFirst: true, greenBuildOnStop: false, maxCyclesPerTask: 12 };
  const wakes = [];
  const runtime = { scheduler: { kickTeam: async () => wakes.push(obligationFrontier(await readTeam(stateRoot, team.id))) }, selections: {} };
  registerBacklogTools(ctx, config, runtime);
  registerTaskTools(ctx, config, runtime);
  registerFlowTools(ctx, config, runtime);
  registerOracleTools(ctx, config);
  registerLifecycleTools(ctx, config, runtime);
  const agent = id => ({ id, session: { header: { cwd: root }, append() {} } });
  return { stateRoot, wakes, captain: agent('cap'), driver: agent('driver-id'), navigator: agent('nav-id'),
    call: (name, args, actor) => defs.get(name).execute(args, { agent: actor }),
    board: () => readTeam(stateRoot, team.id), save: board => writeTeam(stateRoot, board),
  };
}

export async function run(report) {
  const root = await mkdtemp(join(tmpdir(), 'pair-backlog-'));
  const check = async (name, fn) => { try { await fn(); report(true, name); } catch (error) { report(false, `${name}: ${error.stack}`); } };
  try {
    await check('duplicate discoveries persist one record and one Captain mailbox notification; only Captain may triage', async () => {
      const h = await harness(join(root, 'dedupe'));
      const first = await h.call('pair_backlog', discoveryArgs(), h.navigator);
      const again = await h.call('pair_backlog', discoveryArgs({ observation: ' IMPORT recovery loses  the SOURCE filename ' }), h.driver);
      assert.equal(again.reused, true);
      assert.equal(first.discovery.id, again.discovery.id);
      assert.equal((await h.board()).product.discoveries.length, 1);
      const status = await h.call('pair_status', {}, h.captain);
      assert.deepEqual(status, JSON.parse(JSON.stringify(status)), 'untriaged discovery status must remain lossless JSON');
      assert.equal(status.attention_set.find(item => item.tool === 'pair_backlog').ref, first.discovery.id);
      assert.match(status.summary, new RegExp(first.discovery.id));
      const mail = await readMailbox(h.stateRoot, 'backlog', 'captain');
      assert.equal(mail.length, 1);
      assert.match(mail[0].content, new RegExp(first.discovery.id));
      await assert.rejects(h.call('pair_backlog', triageArgs(first.discovery), h.navigator), /only the Captain/);
      assert.equal((await h.board()).product.discoveries[0].status, 'untriaged');
      await h.call('pair_backlog', triageArgs(first.discovery), h.captain);
      assert.equal((await h.board()).product.discoveries[0].status, 'deferred');
    });
    await check('real discovered draft preserves PM evidence and QA criteria but never dispatches, claims, proposes or authors an oracle', async () => {
      for (const parallel of [false, true]) {
        const h = await harness(join(root, `draft-${parallel}`), parallel);
        const { discovery } = await h.call('pair_backlog', discoveryArgs(), h.navigator);
        await assert.rejects(h.call('pair_task_create', cardArgs({ discovery_id: discovery.id, acceptance_criteria: ['Something less demanding'] }), h.captain), /retain every discovered/);
        const { task_id } = await h.call('pair_task_create', cardArgs({ discovery_id: discovery.id }), h.captain);
        const board = await h.board();
        const card = board.tasks.find(task => task.id === task_id);
        assert.equal(card.ready, false);
        assert.deepEqual(card.story.acceptance_criteria, discovery.acceptanceCriteria);
        assert.deepEqual(card.discoveryContext, { observation: discovery.observation, userValue: discovery.userValue, evidence: discovery.evidence });
        assert.equal(obligationFrontier(board).some(item => item.taskId === task_id), false);
        assert.equal(h.wakes.flat().some(item => item.taskId === task_id), false);
        await assert.rejects(h.call('pair_task_claim', { task_id }, h.driver), /TASK_NOT_READY/);
        await assert.rejects(h.call('pair_propose', { task_id, intent: 'repair import error', files: ['src/import.mjs'], verify_plan: 'node tests/import.mjs' }, h.driver), /TASK_NOT_READY/);
        const oracleRefusal = /TASK_NOT_READY/;
        await assert.rejects(h.call('pair_oracle_write', { task_id, path: `.pair-oracles/${task_id}/accept.mjs`, content: 'process.exit(1);' }, h.navigator), oracleRefusal);
        await assert.rejects(h.call('pair_oracle', { task_id, readings: ['Report the failed source filename', 'Report only the upload identifier'], chosen_reading: 'Report the failed source filename', divergence_candidates: ['Two uploads can share an identifier but have different filenames'], oracle_files: [`.pair-oracles/${task_id}/accept.mjs`], oracle_cmd: `node .pair-oracles/${task_id}/accept.mjs` }, h.navigator), oracleRefusal);
        assert.deepEqual((await h.board()).tasks, board.tasks);
        await assert.rejects(h.call('pair_backlog', triageArgs(discovery), h.captain), /already has an iteration draft/);
      }
    });
    await check('out-of-goal discoveries cannot be allocated by Captain or activated through now', async () => {
      const h = await harness(join(root, 'scope'));
      const { discovery } = await h.call('pair_backlog', discoveryArgs({ scope: 'needs_user_decision' }), h.navigator);
      await assert.rejects(h.call('pair_task_create', cardArgs({ discovery_id: discovery.id }), h.captain), /within the current goal/);
      await assert.rejects(h.call('pair_backlog', triageArgs(discovery, { decision: 'now', task_id: 'absent', priority: 1 }), h.captain), /user decision/);
      assert.equal((await h.board()).tasks.length, 0);
      await h.call('pair_backlog', triageArgs(discovery), h.captain);
      assert.equal((await h.board()).product.discoveries[0].status, 'deferred');
    });
    await check('amending a discovery draft cannot silently discard the observed acceptance requirement', async () => {
      const h = await harness(join(root, 'amend'));
      const { discovery } = await h.call('pair_backlog', discoveryArgs(), h.navigator);
      const { task_id } = await h.call('pair_task_create', cardArgs({ discovery_id: discovery.id }), h.captain);
      const before = await h.board();
      await assert.rejects(h.call('pair_task_amend', { task_id, reason: 'Make implementation easier', acceptance_criteria: ['The error has some text'] }, h.captain), /discovered requirement|discovery acceptance|retain/i);
      assert.deepEqual((await h.board()).tasks, before.tasks);
    });
    await check('now activates the exact linked draft and dispatch priority still honors dependency and scope constraints', async () => {
      const h = await harness(join(root, 'priority'), true);
      const normal = await h.call('pair_task_create', cardArgs({ subject: 'Normal import task', write_paths: ['src/import.mjs'], trivial: true }), h.captain);
      const { discovery } = await h.call('pair_backlog', discoveryArgs(), h.navigator);
      const urgent = await h.call('pair_task_create', cardArgs({ discovery_id: discovery.id, trivial: true }), h.captain);
      const independent = await h.call('pair_task_create', cardArgs({ subject: 'Independent parser task', write_paths: ['src/parser.mjs'], trivial: true }), h.captain);
      await h.call('pair_backlog', triageArgs(discovery, { decision: 'now', task_id: urgent.task_id, priority: 1 }), h.captain);
      let board = await h.board();
      const selected = board.tasks.find(task => task.id === urgent.task_id);
      assert.equal(selected.ready, true);
      assert.equal(selected.priority, 1);
      assert.equal(selected.priorityReason, triageArgs(discovery).rationale);
      let claims = obligationFrontier(board).filter(item => item.tool === 'pair_task_claim');
      assert.deepEqual(claims.map(item => item.taskId), [urgent.task_id, independent.task_id]);
      assert.equal(claims.some(item => item.taskId === normal.task_id), false, 'conflicting lower-priority card must wait');
      selected.dependencies = [independent.task_id];
      await h.save(board);
      board = await h.board();
      claims = obligationFrontier(board).filter(item => item.tool === 'pair_task_claim');
      assert.deepEqual(claims.map(item => item.taskId), [normal.task_id, independent.task_id]);
      assert.equal(claims.some(item => item.taskId === urgent.task_id), false, 'priority cannot skip incomplete dependencies');
      const before = structuredClone(board);
      await assert.rejects(h.call('pair_backlog', triageArgs(discovery, { decision: 'now', task_id: urgent.task_id, priority: 3 }), h.captain), /scheduled/);
      assert.deepEqual((await h.board()).tasks, before.tasks);
    });
    await check('status pages discovery history without hiding actionable triage or deleting audit records', async () => {
      const h = await harness(join(root, 'paged-status'));
      const board = await h.board();
      board.product = { discoveries: Array.from({ length: 51 }, (_, i) => ({ id: `finding-${i}`, observation: `Observed ${i}`, userValue: `Benefit ${i}`, status: i === 0 ? 'untriaged' : 'deferred' })) };
      await h.save(board);
      const first = await h.call('pair_status', {}, h.captain);
      assert.equal(first.product.total, 51);
      assert.equal(first.product.discoveries.length, 20);
      assert.equal(first.product.discoveries[0].id, 'finding-0');
      assert.equal(first.product.next_offset, 20);
      const next = await h.call('pair_status', { product_offset: 20, product_limit: 100 }, h.captain);
      assert.equal(next.product.discoveries.length, 31);
      assert.equal(next.product.next_offset, null);
      assert.equal((await h.board()).product.discoveries.length, 51);
      await assert.rejects(h.call('pair_status', { product_limit: 0 }, h.captain), /product_limit/);
    });
    await check('deferred discoveries remain backlog only while untriaged discovery is an explicit stop gate', async () => {
      const h = await harness(join(root, 'completion'));
      const initial = await h.board();
      const baseline = completionReadiness(initial, { greenRequired: false }).failures;
      const { discovery } = await h.call('pair_backlog', discoveryArgs(), h.navigator);
      let board = await h.board();
      assert.equal(board.tasks.length, 0);
      const blockers = completionReadiness(board, { greenRequired: false }).failures;
      assert.equal(blockers.filter(item => /product discovery needs triage/.test(item)).length, 1);
      await assert.rejects(h.call('pair_stop', { outcome: 'complete' }, h.captain), /product discovery needs triage/);
      assert.notEqual((await h.board()).protocol.phase, 'DONE');
      await h.call('pair_backlog', triageArgs(discovery), h.captain);
      board = await h.board();
      assert.equal(board.tasks.length, 0);
      assert.deepEqual(completionReadiness(board, { greenRequired: false }).failures, baseline);
      assert.equal(obligationFrontier(board).some(item => item.tool === 'pair_task_claim'), false);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
