/**
 * Baseline measurements for the third batch of the 2026-09-05 stability review.
 *
 * This is a BASELINE HARNESS, not a regression gate: it prints numbers for the
 * current machine and exits 0 whether they are good or bad. Nothing here calls
 * a model, spawns a real host or touches the repository — every case runs
 * against a temp directory with an in-memory stub host, so what it measures is
 * the plugin's own persistence and scheduling cost, not the SDK's.
 *
 * Run:  node docs/diagnostics/2026-09-05-bench.mjs
 */
import { mkdtemp, rm, stat, readdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteText } from '../../lib/state/atomic.js';
import { appendMailbox, createMessage, readUnreadMailbox, claimMailboxDelivery, acknowledgeMailbox } from '../../lib/state/mailbox.js';
import { createTeamDir, readTeam, writeTeam, removeTeamDir, inspectTeams, recordRetiredMemberIds, readRetiredMemberIds } from '../../lib/state/store.js';
import { initialProtocolState } from '../../lib/protocol/machine.js';
import { installPairScheduler } from '../../lib/runtime/scheduler.js';
import { recycleMember } from '../../lib/runtime/recycle.js';

const ms = (t) => `${(Number(t) / 1e6).toFixed(1)} ms`;
const now = () => process.hrtime.bigint();
const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

const team = (id, overrides = {}) => ({
  id, name: id, goal: 'bench', mode: 'light',
  captainSessionId: 'cap', createdAt: 1, updatedAt: 1, taskSeq: 0, tasks: [],
  members: [{ id: 'seat-0', name: 'driver', role: 'driver', status: 'idle', joinedAt: 1 }],
  protocol: { ...initialProtocolState(), phase: 'CYCLING' },
  ...overrides,
});

/** A host stub that accepts every spawn and records nothing but counts. */
function stubHost(counters) {
  const captain = { id: 'cap', options: { provider: 'p', model: 'm' }, session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } };
  return {
    logger: { warn() { counters.warnings += 1; } },
    agents: { get: (id) => (id === 'cap' ? captain : { cancel() {} }) },
    tools: { schemas: () => [{ name: 'read' }] },
    llm: { resolveCallConfig: async (v) => v },
    subagents: {
      getProvider: () => ({ prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } }),
      startContinuable: async () => ({ childId: `seat-${++counters.spawns}` }),
      interrupt: () => { counters.interrupts += 1; },
    },
  };
}

async function mailboxScaling(root) {
  console.log('\n== 1. mailbox: O(1) append (0.13.7; was read-all + rewrite-all) ==');
  console.log('n     append total   per-msg   file      bytes written   old path would   unread scan   claim+ack');
  for (const n of [100, 250, 500, 1000]) {
    const stateRoot = join(root, `mail-${n}`);
    const id = 'team';
    await createTeamDir(stateRoot, team(id));
    // `written` is what this append path actually puts on disk; `wouldRewrite`
    // is what the pre-0.13.7 read-and-rewrite path would have moved for the
    // same messages. Keeping both is the point of the column pair.
    let written = 0, wouldRewrite = 0, previous = 0;
    const file = join(stateRoot, id, 'inbox', 'captain.jsonl');
    const t0 = now();
    for (let i = 0; i < n; i += 1) {
      await appendMailbox(stateRoot, id, 'captain', createMessage('driver', 'captain', `message ${i} padded to a realistic length for a board note`));
      const size = (await stat(file)).size;
      written += size - previous;
      previous = size;
      wouldRewrite += size;
    }
    const appendNs = now() - t0;
    const size = (await stat(file)).size;
    const t1 = now();
    const unread = await readUnreadMailbox(stateRoot, id, 'captain');
    const scanNs = now() - t1;
    const t2 = now();
    await claimMailboxDelivery(stateRoot, id, 'captain', [unread[0].id]);
    await acknowledgeMailbox(stateRoot, id, 'captain', [unread[0].id]);
    const ackNs = now() - t2;
    console.log(`${String(n).padEnd(6)}${ms(appendNs).padEnd(15)}${ms(appendNs / BigInt(n)).padEnd(10)}${kib(size).padEnd(10)}${kib(written).padEnd(16)}${kib(wouldRewrite).padEnd(17)}${ms(scanNs).padEnd(14)}${ms(ackNs)}`);
  }
}

async function boardScaling(root) {
  console.log('\n== 2. team board: whole-file read/write as cycle history grows ==');
  console.log('cycles  board     write     read');
  for (const cycles of [0, 25, 100, 400]) {
    const stateRoot = join(root, `board-${cycles}`);
    const state = team('team');
    state.protocol.cycles = Array.from({ length: cycles }, (_, i) => ({
      n: i, verify: { verdict: 'accept', at: i + 2 },
      evidence: `cycle ${i}: a representative acceptance note with enough prose to matter`,
    }));
    await createTeamDir(stateRoot, state);
    const t0 = now();
    for (let i = 0; i < 20; i += 1) await writeTeam(stateRoot, state);
    const writeNs = (now() - t0) / 20n;
    const t1 = now();
    for (let i = 0; i < 20; i += 1) await readTeam(stateRoot, 'team');
    const readNs = (now() - t1) / 20n;
    const size = (await stat(join(stateRoot, 'team', 'team.json'))).size;
    console.log(`${String(cycles).padEnd(8)}${kib(size).padEnd(10)}${ms(writeNs).padEnd(10)}${ms(readNs)}`);
  }
}

async function coldRecovery(root) {
  console.log('\n== 3. cold recovery: session-start rediscovery over a workspace ==');
  console.log('teams   broken  inspectTeams   tracked');
  for (const count of [10, 50, 200]) {
    const workspace = join(root, `recover-${count}`);
    const stateRoot = join(workspace, 'state');
    for (let i = 0; i < count; i += 1) await createTeamDir(stateRoot, team(`t${i}`));
    await writeFile(join(stateRoot, 't0', 'team.json'), '{');
    const handlers = new Map();
    const ctx = { on: (n, f) => handlers.set(n, f), logger: { warn() {} }, agents: { get() {} }, subagents: {} };
    const scheduler = installPairScheduler(ctx, { stateDir: 'state', heartbeatMs: 0 });
    const t0 = now();
    const snapshot = await inspectTeams(stateRoot);
    const scanNs = now() - t0;
    await handlers.get('agent/session-start')({ agent: { id: 'cap', session: { header: { cwd: workspace } } } });
    console.log(`${String(count).padEnd(8)}${String(snapshot.errors.length).padEnd(8)}${ms(scanNs).padEnd(15)}${scheduler.trackedTeams().length}`);
    handlers.get('dispose')();
  }
}

async function recycleLoop(root) {
  console.log('\n== 4. 100 recycles on one team: seat churn and process-local growth ==');
  const workspace = join(root, 'churn');
  const stateRoot = join(workspace, 'state');
  await createTeamDir(stateRoot, team('churn'));
  const counters = { spawns: 0, interrupts: 0, warnings: 0 };
  const handlers = new Map();
  const ctx = stubHost(counters);
  ctx.on = (n, f) => handlers.set(n, f);
  const scheduler = installPairScheduler(ctx, { stateDir: 'state', heartbeatMs: 0 });
  scheduler.trackTeam(workspace, 'churn');
  const runtime = { selections: { withPending: async (_p, _l, _s, fn) => fn() }, releaseTeamSeats: scheduler.releaseTeamSeats };
  const config = { memberLifetime: 'cycle', memberProvider: 'test', stateDir: 'state' };
  const t0 = now();
  let recycled = 0;
  for (let i = 0; i < 100; i += 1) {
    const result = await recycleMember(ctx, config, runtime, stateRoot, 'churn', 'driver', { force: true });
    if (result.recycled) recycled += 1;
  }
  const loopNs = now() - t0;
  const board = await readTeam(stateRoot, 'churn');
  const live = board.members.filter((m) => m.status !== 'removed');
  const diagnostics = scheduler.diagnostics();
  const retiredSize = (await stat(join(stateRoot, 'retired-members.json')).catch(() => ({ size: 0 }))).size;
  const leftovers = (await readdir(join(stateRoot, 'churn'))).filter((n) => n.endsWith('.tmp'));
  console.log(`recycled          ${recycled}/100  (${ms(loopNs)} total, ${ms(loopNs / 100n)} each)`);
  console.log(`live seats        ${live.length} (${live.map((m) => m.id).join(', ')})`);
  console.log(`interrupts        ${counters.interrupts}   warnings ${counters.warnings}`);
  console.log(`seat map entries  nudges=${diagnostics.seatEntries.nudges} activity=${diagnostics.seatEntries.activity} parked=${diagnostics.seatEntries.parked}`);
  console.log(`retired deny-list ${kib(retiredSize)} for the retired ids (append-only by design)`);
  console.log(`orphan temp files ${leftovers.length}`);
  handlers.get('dispose')();
}

async function startStopLoop(root) {
  console.log('\n== 5. 100 create/stop cycles: does the workspace stay clean? ==');
  const stateRoot = join(root, 'lifecycle');
  const t0 = now();
  for (let i = 0; i < 100; i += 1) {
    await createTeamDir(stateRoot, team(`t${i}`));
    await writeTeam(stateRoot, { ...team(`t${i}`), protocol: { ...initialProtocolState(), phase: 'DONE' } });
    await removeTeamDir(stateRoot, `t${i}`);
  }
  const loopNs = now() - t0;
  const left = await readdir(stateRoot).catch(() => []);
  console.log(`100 create/write/remove  ${ms(loopNs)} total, ${ms(loopNs / 100n)} each`);
  console.log(`entries left behind      ${left.length} (${left.join(', ') || 'none'})`);
}

async function retiredDenyList(root) {
  console.log('\n== 6. retired deny-list: the one durable structure with no compaction ==');
  console.log('ids     file      last write   full read');
  const stateRoot = join(root, 'retired');
  let written = 0;
  for (const target of [100, 500, 2000, 8000]) {
    let last = 0n;
    while (written < target) {
      const t0 = now();
      await recordRetiredMemberIds(stateRoot, [`seat-${written}`]);
      last = now() - t0;
      written += 1;
    }
    const t1 = now();
    const set = await readRetiredMemberIds(stateRoot);
    const readNs = now() - t1;
    const size = (await stat(join(stateRoot, 'retired-members.json'))).size;
    console.log(`${String(set.size).padEnd(8)}${kib(size).padEnd(10)}${ms(last).padEnd(13)}${ms(readNs)}`);
  }
}

async function writeCost(root) {
  console.log('\n== 7. the two write paths, measured (200 ops on a 160 KiB file) ==');
  const dir = join(root, 'writecost');
  await createTeamDir(dir, team('t'));
  const line = JSON.stringify(createMessage('driver', 'captain', 'a representative board note')) + '\n';
  const seed = line.repeat(1000);
  const atomicTarget = join(dir, 'atomic.jsonl'), appendTarget = join(dir, 'append.jsonl');
  await writeFile(atomicTarget, seed); await writeFile(appendTarget, seed);
  const t0 = now();
  for (let i = 0; i < 200; i += 1) await readFile(atomicTarget, 'utf8');
  const readNs = (now() - t0) / 200n;
  const t1 = now();
  for (let i = 0; i < 200; i += 1) await atomicWriteText(atomicTarget, seed + line);
  const atomicNs = (now() - t1) / 200n;
  const t2 = now();
  for (let i = 0; i < 200; i += 1) await appendFile(appendTarget, line, 'utf8');
  const appendNs = (now() - t2) / 200n;
  console.log(`read whole file        ${ms(readNs)}`);
  console.log(`atomic rewrite         ${ms(atomicNs)}  (temp write + rename; what mutateMailbox still does)`);
  console.log(`plain O(1) appendFile  ${ms(appendNs)}  (what appendMailbox does since 0.13.7)`);
}

const root = await mkdtemp(join(tmpdir(), 'pair-bench-'));
console.log(`node ${process.version} on ${process.platform}; temp root ${root}`);
try {
  await mailboxScaling(root);
  await boardScaling(root);
  await coldRecovery(root);
  await recycleLoop(root);
  await startStopLoop(root);
  await retiredDenyList(root);
  await writeCost(root);
} finally {
  await rm(root, { recursive: true, force: true });
}
