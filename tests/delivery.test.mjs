/** Durable transport regressions. Real temp JSONL; host admission is a fault boundary, not a model efficacy test. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mailbox from '../lib/state/mailbox.js';
import { createTeamDir, readTeam, writeTeam, commitMemberReplacement } from '../lib/state/store.js';
import { retireSpawnedMembers } from '../lib/runtime/retire.js';
import { prepareMailboxDelivery, finishMailboxDelivery } from '../lib/runtime/mail-delivery.js';
import { initialProtocolState, openCycle } from '../lib/protocol/machine.js';
import { encodeMessage, decodeMessage } from '../lib/protocol/messages.js';
import { installPairScheduler } from '../lib/runtime/scheduler.js';
import { deliverProtocolMessage } from '../lib/tools/shared.js';
import { registerFlowTools } from '../lib/tools/flow.js';
import { toolDenyListFor } from '../lib/runtime/members.js';
import { withLock } from '../lib/state/lock.js';
import { teamLockKey } from '../lib/state/layout.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function entered(promise) {
  let timer;
  try { return await Promise.race([promise.then(() => true), new Promise(r => { timer = setTimeout(() => r(false), 1500); })]); }
  finally { clearTimeout(timer); }
}
function fixture(id) {
  return { id, name: id, goal: 'transport', mode: 'light', tddMode: 'enforce', pairStyle: 'traditional',
    captainSessionId: 'cap', createdAt: 1, updatedAt: 1,
    members: ['driver', 'navigator'].map(name => ({ id: name, name, role: name, status: 'idle', joinedAt: 1 })),
    tasks: [], taskSeq: 0, protocol: initialProtocolState(), evidenceStats: { cacheHits: 0, cacheMiss: 0 } };
}
function harness(root, send, captainId = 'cap') {
  const calls = [], captainCalls = [], defs = [], handlers = new Map(), statuses = new Map();
  const captain = { id: captainId, status: 'idle', session: { header: { cwd: root }, append() {} }, followup: message => captainCalls.push(message.content[0].text), steer: message => captainCalls.push(message.content[0].text) };
  const ctx = { logger: { warn() {}, debug() {} }, on: (n, fn) => handlers.set(n, fn),
    agents: { get: id => id === captain.id ? captain : statuses.get(id) },
    tools: { register: d => defs.push(d) },
    subagents: { sendMessage: async (_from, childId, content, options) => {
      calls.push({ childId, text: content[0].text });
      return send ? send(childId, content[0].text, options) : 'accepted';
    } } };
  const config = { stateDir: 'state', heartbeatMs: 0, oracleFirst: false };
  const scheduler = installPairScheduler(ctx, config);
  return { ctx, config, scheduler, calls, captainCalls, defs, handlers, statuses, captain,
    caller: { id: 'navigator', session: { header: { cwd: root }, append() {} } } };
}
async function append(root, team, recipient, content) {
  const message = mailbox.createMessage('navigator', recipient, content);
  await withLock(teamLockKey(root, team.id), () => mailbox.appendMailbox(root, team.id, recipient, message));
  return message;
}

export async function run(check) {
  const root = await mkdtemp(join(tmpdir(), 'pair-delivery-'));
  const state = join(root, 'state');
  try {
    const legacy = encodeMessage('GREEN', { cycle_id: 'c1', green_evidence: 'g' }) + '\n\n[PAIR:NEXT] OLD-NEXT';
    check(decodeMessage(legacy)?.body?.cycle_id === 'c1', 'legacy NEXT trailers do not poison protocol JSON decoding');

    const leases = fixture('leases'); await createTeamDir(state, leases);
    const m = await append(state, leases, 'driver', 'durable');
    const first = await mailbox.claimMailboxDelivery(state, leases.id, 'driver', [m.id, 'missing']);
    check(typeof first?.claimId === 'string' && first.messageIds.length === 1 && first.messageIds[0] === m.id, 'claim returns unique token and only actual eligible ids');
    const overlapping = await mailbox.claimMailboxDelivery(state, leases.id, 'driver', [m.id]);
    check(overlapping?.messageIds.length === 0, 'an unexpired claimed message cannot be claimed twice');
    await mailbox.releaseMailboxDelivery(state, leases.id, 'driver', [m.id], first?.claimId);
    const second = await mailbox.claimMailboxDelivery(state, leases.id, 'driver', [m.id]);
    check(first?.claimId !== second?.claimId, 'every renewed delivery gets a different claim identity');
    await mailbox.acknowledgeMailbox(state, leases.id, 'driver', [m.id], first?.claimId);
    let disk = (await mailbox.readMailbox(state, leases.id, 'driver'))[0];
    check(disk.readAt === undefined && disk.deliveryClaimId === second?.claimId, 'late ACK cannot consume a renewed lease');
    await mailbox.releaseMailboxDelivery(state, leases.id, 'driver', [m.id], first?.claimId);
    disk = (await mailbox.readMailbox(state, leases.id, 'driver'))[0];
    check(disk.deliveryClaimId === second?.claimId, 'late release cannot erase a renewed lease');
    await mailbox.acknowledgeMailbox(state, leases.id, 'driver', [m.id], second?.claimId);
    check((await mailbox.readUnreadMailbox(state, leases.id, 'driver')).length === 0, 'the current claim can ACK host admission');
    const expired = { ...mailbox.createMessage('navigator', 'driver', 'expired lease'), deliveryClaimId: 'old-crashed-claim', deliveryClaimedAt: Date.now() - 61000 };
    await mailbox.appendMailbox(state, leases.id, 'driver', expired);
    const renewed = await mailbox.claimMailboxDelivery(state, leases.id, 'driver', [expired.id]);
    await mailbox.acknowledgeMailbox(state, leases.id, 'driver', [expired.id], 'old-crashed-claim');
    check(renewed.messageIds[0] === expired.id && (await mailbox.readMailbox(state, leases.id, 'driver')).find(row => row.id === expired.id).readAt === undefined, 'expired crash leases can be reclaimed and old callbacks stay harmless');

    const oversized = fixture('oversized'); oversized.members[0].id = 'overflow-driver'; oversized.members[1].id = 'overflow-nav';
    await createTeamDir(state, oversized);
    const huge = await append(state, oversized, 'driver', '🧪界'.repeat(10000) + 'END-OF-CONTROL');
    const ho = harness(root); await ho.scheduler.kickMember(root, oversized.id, 'driver');
    check(Buffer.byteLength(ho.calls[0].text) <= 16384 && ho.calls[0].text.includes('pair_mailbox_read') && ho.calls[0].text.includes(huge.id), 'oversized durable content is delivered as an explicit bounded reference with its id');
    let readTool;
    try { (await import('../lib/tools/mailbox.js')).registerMailboxTools(ho.ctx, ho.config); readTool = ho.defs.find(d => d.name === 'pair_mailbox_read').execute; } catch {}
    let recovered = '', offset = 0, pageCount = 0, longest = 0, readError;
    if (readTool !== undefined) {
      try {
        do {
          const page = await readTool({ message_id: huge.id, offset, max_chars: 4000 }, { agent: { ...ho.caller, id: 'overflow-driver' } });
          recovered += page.content; longest = Math.max(longest, page.content.length); offset = page.next_offset; pageCount++;
        } while (offset !== null && pageCount <= 30);
      } catch (error) { readError = String(error); }
    }
    check(readTool !== undefined && readError === undefined && recovered === huge.content && longest <= 4000 && pageCount > 1, 'all overflow content is recoverable by bounded pages after host notification ACK');
    let otherRefused = false, excessiveRefused = false;
    if (readTool !== undefined) {
      try { await readTool({ message_id: huge.id }, { agent: { ...ho.caller, id: 'overflow-nav' } }); } catch { otherRefused = true; }
      try { await readTool({ message_id: huge.id, max_chars: 4001 }, { agent: { ...ho.caller, id: 'overflow-driver' } }); } catch { excessiveRefused = true; }
    }
    check(otherRefused && excessiveRefused, 'own-mail read refuses another recipient id and page requests above 4000 chars');
    check(!toolDenyListFor('spec', new Set(['pair_oracle', 'pair_oracle_write', 'pair_status', 'pair_mailbox_read', 'read'])).includes('pair_mailbox_read'), 'SPEC can recover its own delivered overflow while repository reads stay denied');

    const burst = fixture('burst'); await createTeamDir(state, burst);
    for (let i = 0; i < 14; i++) await append(state, burst, 'driver', `routine-${i} ` + '界😀'.repeat(900));
    const controls = [];
    for (let i = 0; i < 10; i++) controls.push(await append(state, burst, 'driver', encodeMessage('REJECT', { cycle_id: 'c1', feedback: `urgent-${i}` })));
    const h = harness(root); await h.scheduler.kickMember(root, burst.id, 'driver');
    const delivered = (await mailbox.readMailbox(state, burst.id, 'driver')).filter(row => row.readAt !== undefined);
    check(h.calls.length === 1 && Buffer.byteLength(h.calls[0].text, 'utf8') <= 16 * 1024, 'burst produces exactly one delivery bounded to 16KiB including metadata');
    check(delivered.length <= 8 && delivered.length > 0 && (await mailbox.readUnreadMailbox(state, burst.id, 'driver')).length === 24 - delivered.length, 'only at most eight selected records are ACKed; backlog stays durable');
    check(delivered.some(row => row.id === controls[0].id) && delivered.some(row => row.content.startsWith('routine-')), 'control behind routine traffic is selected while reserving an ordinary slot');
    for (let i = 0; i < 4; i++) await h.scheduler.kickMember(root, burst.id, 'driver');
    check((await mailbox.readMailbox(state, burst.id, 'driver')).every(row => row.readAt !== undefined) && h.calls.every(call => Buffer.byteLength(call.text) <= 16384), 'bounded later kicks eventually drain every record without exceeding the byte ceiling');

    const stale = fixture('stale');
    stale.tasks = [{ id: 't-1', subject: 'task', status: 'in_progress', assignee: 'driver', attemptId: 'a1', dependencies: [], oracle: { sha: 'seal' }, createdAt: 1, updatedAt: 1 }];
    const cycle = openCycle(stale.protocol, 't-1', { tddMode: 'enforce' });
    cycle.step = 'GREEN'; cycle.green = {}; cycle.oracleSha = 'seal';
    await createTeamDir(state, stale);
    await append(state, stale, 'navigator', encodeMessage('GREEN', { cycle_id: cycle.id }) + '\n\n[PAIR:NEXT] OLD-NEXT pair_red');
    const hs = harness(root); await hs.scheduler.kickMember(root, stale.id, 'navigator');
    check(hs.calls[0].text.includes('pair_verify') && hs.calls[0].text.includes('YOU owe') && !hs.calls[0].text.includes('OLD-NEXT'), 'delivery derives the recipient current obligation and removes queued stale NEXT prose');

    const busy = fixture('busy'); await createTeamDir(state, busy);
    const hb = harness(root); hb.statuses.set('driver', { id: 'driver', status: 'running' });
    await deliverProtocolMessage(hb.ctx, hb.config, hb.caller, busy, 'driver', encodeMessage('INFO', { text: 'routine' }), {});
    check(hb.calls.length === 0 && (await mailbox.readUnreadMailbox(state, busy.id, 'driver')).length === 1, 'routine mail to a busy host stays durable without entering the host inbox');
    await deliverProtocolMessage(hb.ctx, hb.config, hb.caller, busy, 'driver', encodeMessage('REJECT', { feedback: 'stop this change' }), {});
    check(hb.calls.length === 1 && Buffer.byteLength(hb.calls[0].text) <= 16384, 'one bounded critical notification can reach a busy host');
    await deliverProtocolMessage(hb.ctx, hb.config, hb.caller, busy, 'driver', encodeMessage('NO_GO', { feedback: 'another correction' }), {});
    check(hb.calls.length === 1, 'further control traffic stays durable until the busy turn yields');
    check((await mailbox.readMailbox(state, busy.id, 'driver')).every(row => !row.content.includes('[PAIR:NEXT]')), 'new durable records store raw protocol content, not derived NEXT prose');

    const captainMail = fixture('captain-mail'); captainMail.captainSessionId = 'mail-captain'; await createTeamDir(state, captainMail);
    const hm = harness(root, undefined, 'mail-captain'); hm.captain.status = 'running';
    for (let i = 0; i < 10; i++) await deliverProtocolMessage(hm.ctx, hm.config, hm.caller, captainMail, 'captain', encodeMessage('INFO', { text: 'queued-' + i }), {});
    check(hm.captainCalls.length === 0, 'busy captain routine mail is not pushed into its host inbox');
    await deliverProtocolMessage(hm.ctx, hm.config, hm.caller, captainMail, 'captain', encodeMessage('GATE_FAIL', { failures: ['stop'] }), {});
    await deliverProtocolMessage(hm.ctx, hm.config, hm.caller, captainMail, 'captain', encodeMessage('REJECT', { feedback: 'another correction' }), {});
    check(hm.captainCalls.length === 1 && hm.captainCalls.every(text => Buffer.byteLength(text) <= 16384), 'busy captain gets one critical batch, with the whole host envelope inside 16KiB');
    hm.captain.status = 'idle';
    await hm.scheduler.kickTeam(root, captainMail.id);
    check(hm.captainCalls.length === 2, 'kickTeam drains captain mail as an independent bounded mail-only seat');
    await append(state, captainMail, 'captain', 'idle-edge-only');
    const captainIdle = deferred(), originalFollowup = hm.captain.followup;
    hm.captain.followup = message => { originalFollowup(message); captainIdle.resolve(); };
    hm.handlers.get('agent/status')({ agent: hm.captain, status: 'idle' });
    check(await entered(captainIdle.promise), 'captain idle edge drains durable mail without a new sender or heartbeat');

    const recycle = fixture('recycle'); await createTeamDir(state, recycle); await append(state, recycle, 'driver', 'must survive recycled seat');
    const hr = harness(root, async () => {
      await withLock(teamLockKey(state, recycle.id), async () => { const fresh = await readTeam(state, recycle.id); fresh.members[0].id = 'new-driver'; await writeTeam(state, fresh); });
      return 'late admission';
    });
    await hr.scheduler.kickMember(root, recycle.id, 'driver');
    check((await mailbox.readUnreadMailbox(state, recycle.id, 'driver')).length === 1, 'acceptance for a recycled child cannot ACK its successor mailbox');
    const stopped = fixture('stopped'); await createTeamDir(state, stopped); await append(state, stopped, 'driver', 'stop during admission');
    const hz = harness(root, async () => {
      await withLock(teamLockKey(state, stopped.id), async () => { const fresh = await readTeam(state, stopped.id); fresh.protocol.phase = 'ABORTED'; await writeTeam(state, fresh); });
      return 'late admission';
    });
    await hz.scheduler.kickMember(root, stopped.id, 'driver');
    check((await mailbox.readUnreadMailbox(state, stopped.id, 'driver')).length === 1, 'acceptance after team stop does not ACK mail');

    const parallel = fixture('parallel'); await createTeamDir(state, parallel);
    await append(state, parallel, 'driver', 'driver mail'); await append(state, parallel, 'navigator', 'navigator mail');
    const release = deferred(), navEntered = deferred(), driverEntered = deferred();
    const hp = harness(root, async id => { if (id === 'driver') { driverEntered.resolve(); await release.promise; } else navEntered.resolve(); return 'ok'; });
    const run = hp.scheduler.kickTeam(root, parallel.id);
    await entered(driverEntered.promise);
    const duplicate = hp.scheduler.kickMember(root, parallel.id, 'driver');
    const independent = await entered(navEntered.promise);
    release.resolve(); await Promise.all([run, duplicate]);
    check(independent, 'one hung seat cannot block a different seat entering host delivery');
    check(hp.calls.filter(call => call.childId === 'driver').length === 1, 'duplicate in-flight kicks coalesce without queued follow-up deliveries');
    const overlap = fixture('overlap'); await createTeamDir(state, overlap); await append(state, overlap, 'driver', 'fallback first');
    const inside = deferred(), exitHost = deferred(); const hx = harness(root, async () => { inside.resolve(); await exitHost.promise; return 'ok'; });
    const fallback = hx.scheduler.kickMember(root, overlap.id, 'driver'); await entered(inside.promise);
    const direct = await deliverProtocolMessage(hx.ctx, hx.config, hx.caller, overlap, 'driver', encodeMessage('REJECT', { feedback: 'later correction' }), {});
    check(direct.delivered === 'mailbox' && (await mailbox.readUnreadMailbox(state, overlap.id, 'driver')).length === 1, 'control mail appended during an in-flight fallback is durable before anything else runs');
    exitHost.resolve(); await fallback;
    // M16': the coalesced notification used to be dropped outright, which left
    // this correction waiting for the next 120s sweep. It is now deferred to
    // the end of the flight that swallowed it — preserved AND delivered.
    check(hx.calls.length === 2 && hx.calls[1].text.includes('later correction'), 'direct notification coalesces with fallback in flight, and the control mail appended during it is delivered by the re-armed wake');
    check(hx.calls.every(call => Buffer.byteLength(call.text, 'utf8') <= 16 * 1024), 'the re-armed wake stays inside the same delivery byte ceiling as the flight it follows');

    const failure = fixture('failure'); await createTeamDir(state, failure); await append(state, failure, 'driver', 'retry me');
    const hf = harness(root, async () => { throw new Error('DRAINING'); }); await hf.scheduler.kickMember(root, failure.id, 'driver');
    check((await mailbox.readUnreadMailbox(state, failure.id, 'driver')).length === 1, 'host refusal releases selected leases for retry');
    await append(state, failure, 'navigator', 'healthy seat'); await hf.scheduler.kickTeam(root, failure.id);
    check(hf.calls.some(call => call.childId === 'navigator'), 'a refused member cannot prevent another member delivery attempt');
    const cancelled = fixture('cancelled'); await createTeamDir(state, cancelled); await append(state, cancelled, 'driver', 'retain after cancel');
    const controller = new AbortController(); const hc = harness(root, async () => { controller.abort(); return 'late accepted'; });
    await hc.scheduler.kickMember(root, cancelled.id, 'driver', undefined, controller.signal);
    check((await mailbox.readUnreadMailbox(state, cancelled.id, 'driver')).length === 1, 'acceptance after cancellation does not consume durable mail');

    const claimed = fixture('claimed'); claimed.members[0].id = 'claimed-driver';
    claimed.tasks = [{ id: 't-1', subject: 'owned', assignee: 'driver', status: 'claimed', attemptId: 'same-attempt', attempt: 1, dependencies: [], createdAt: 1, updatedAt: 1 },
      { id: 't-2', subject: 'other owner', assignee: 'navigator', status: 'pending', dependencies: [], createdAt: 1, updatedAt: 1 }];
    await createTeamDir(state, claimed); const ht = harness(root); registerFlowTools(ht.ctx, ht.config, { scheduler: ht.scheduler });
    const claim = ht.defs.find(d => d.name === 'pair_task_claim').execute;
    let result; try { result = await claim({ task_id: 't-1' }, { agent: { ...ht.caller, id: 'claimed-driver' } }); } catch {}
    check(result?.attempt_id === 'same-attempt', 'same-task claim after scheduler preclaim returns its current attempt idempotently');
    claimed.tasks[0].status = 'completed'; await writeTeam(state, claimed);
    let refused = false; try { await claim({ task_id: 't-2' }, { agent: { ...ht.caller, id: 'claimed-driver' } }); } catch { refused = true; }
    check(refused && (await readTeam(state, claimed.id)).tasks[1].assignee === 'navigator', 'a claim cannot take another member assigned task');
    const pool = fixture('pool'); pool.tasks = [{ id: 'pool-1', subject: 'implementation', status: 'pending', dependencies: [], createdAt: 1, updatedAt: 1 }];
    await createTeamDir(state, pool); const hn = harness(root); await hn.scheduler.kickMember(root, pool.id, 'navigator');
    check((await readTeam(state, pool.id)).tasks[0].assignee === undefined, 'a non-Driver never auto-claims shared implementation work');

    const independentWork = fixture('independent-work');
    independentWork.tasks = [{ id: 'active', subject: 'implementation', status: 'in_progress', assignee: 'driver', attemptId: 'build-attempt', dependencies: [], oracle: { sha: 'active-seal' }, createdAt: 1, updatedAt: 1 },
      { id: 'future', subject: 'future specification', status: 'pending', dependencies: [], createdAt: 1, updatedAt: 1 }];
    const implementing = openCycle(independentWork.protocol, 'active', { tddMode: 'enforce' }); implementing.step = 'GO'; implementing.oracleSha = 'active-seal';
    await createTeamDir(state, independentWork); const hi = harness(root); hi.config.oracleFirst = true;
    await hi.scheduler.kickTeam(root, independentWork.id);
    check(hi.calls.some(call => call.childId === 'driver' && call.text.includes('pair_green')) && hi.calls.some(call => call.childId === 'navigator' && call.text.includes('pair_oracle_write') && call.text.includes('future')), 'both current implementation and independent future oracle preparation get recipient-specific obligations');
    const updated = await readTeam(state, independentWork.id); updated.members[0].activity = { lastActivityAt: Date.now() }; await writeTeam(state, updated);
    await hi.scheduler.kickTeam(root, independentWork.id);
    check(hi.calls.length === 2 && (await readTeam(state, independentWork.id)).tasks[1].assignee === undefined, 'metadata-only writes do not repeat a future draft nudge or claim another canonical task');
    const disabledOracle = fixture('disabled-oracle'); disabledOracle.tasks = [{ id: 'ready', subject: 'legacy', status: 'pending', dependencies: [], createdAt: 1, updatedAt: 1 }];
    await createTeamDir(state, disabledOracle); const hd = harness(root); await hd.scheduler.kickTeam(root, disabledOracle.id);
    check(hd.calls.length === 1 && hd.calls[0].childId === 'driver' && hd.calls[0].text.includes('pair_task_claim'), 'scheduler honors config.oracleFirst=false instead of waking an oracle author');
    const research = fixture('research'); research.members[1].id = 'research-nav';
    research.tasks = [{ id: 'research-1', subject: 'read-only investigation', type: 'spike', assignee: 'navigator', status: 'pending', dependencies: [], createdAt: 1, updatedAt: 1 }];
    await createTeamDir(state, research); const ha = harness(root); await ha.scheduler.kickMember(root, research.id, 'navigator');
    const preclaimed = (await readTeam(state, research.id)).tasks[0]; registerFlowTools(ha.ctx, ha.config, { scheduler: ha.scheduler });
    let confirmation; try { confirmation = await ha.defs.find(def => def.name === 'pair_task_claim').execute({ task_id: 'research-1' }, { agent: { ...ha.caller, id: 'research-nav' } }); } catch {}
    check(preclaimed.assignee === 'navigator' && typeof preclaimed.attemptId === 'string' && confirmation?.attempt_id === preclaimed.attemptId && confirmation?.attempt === 1, 'explicitly assigned research is preclaimed once and its real claim-tool confirmation keeps that attempt');

    const quiet = fixture('quiet-captain'); quiet.captainSessionId = 'quiet-cap'; quiet.tasks = [{ id: 'finished', subject: 'done', status: 'completed', dependencies: [], createdAt: 1, updatedAt: 1 }];
    await createTeamDir(state, quiet); await append(state, quiet, 'captain', 'completion receipt waiting');
    const hq = harness(root, undefined, 'quiet-cap'); hq.scheduler.trackTeam(root, quiet.id); await hq.scheduler.heartbeat();
    check(hq.captainCalls.length === 1, 'terminal tasks do not untrack a team while captain notification mail remains');

    const absorbed = fixture('absorbed'); absorbed.protocol.cycles = [{ id: 'done-cycle', taskId: 'done-task', step: 'VERIFIED', green: {}, verify: { verdict: 'accept' } }];
    await createTeamDir(state, absorbed);
    const receipts = [];
    for (let i = 0; i < 1000; i++) receipts.push(await append(state, absorbed, 'driver', encodeMessage('GREEN', { cycle_id: 'done-cycle', green_evidence: `receipt-${i}` })));
    const summary = await prepareMailboxDelivery(state, absorbed.id, 'driver', {}, { memberId: 'driver', captainId: 'cap' });
    check(summary.count === 1 && summary.physicalCount === 1000 && summary.messageIds.length === 1000 && summary.backlog === 0 && summary.bytes < 1600, '1000 absorbed receipts become one bounded logical notification leasing all physical ids');
    await finishMailboxDelivery(state, summary, false);
    check((await mailbox.readUnreadMailbox(state, absorbed.id, 'driver')).length === 1000, 'failed summary admission releases all represented receipt leases');
    const reclaim = await prepareMailboxDelivery(state, absorbed.id, 'driver', {}, { memberId: 'driver', captainId: 'cap' });
    await finishMailboxDelivery(state, summary, true);
    const reclaimDisk = await mailbox.readMailbox(state, absorbed.id, 'driver');
    check(reclaimDisk.every(row => row.readAt === undefined) && reclaim.messageIds.every(id => reclaimDisk.find(row => row.id === id)?.deliveryClaimId === reclaim.claimId), 'late summary ACK cannot consume any reclaimed receipt');
    await finishMailboxDelivery(state, reclaim, true, { aborted: true });
    check((await mailbox.readUnreadMailbox(state, absorbed.id, 'driver')).length === 1000, 'cancelled summary admission releases every represented record');
    const drain = harness(root); await drain.scheduler.kickMember(root, absorbed.id, 'driver');
    const allReceipts = await mailbox.readMailbox(state, absorbed.id, 'driver');
    const diagnostic = drain.scheduler.diagnostics().mail.find(row => row.teamId === absorbed.id);
    check(drain.calls.length === 1 && allReceipts.length === 1000 && allReceipts.every((row, i) => row.readAt !== undefined && row.content === receipts[i].content && row.id === receipts[i].id), 'one accepted notification drains a thousand receipts while retaining every original JSONL record');
    check(diagnostic?.selected === 1 && diagnostic?.physicalCount === 1000 && diagnostic?.backlog === 0, 'delivery diagnostics distinguish logical notification count from physical receipt count');
    for (let i = 0; i < 30; i++) await append(state, absorbed, 'navigator', receipts[i].content);
    const urgent = [];
    for (let i = 0; i < 9; i++) urgent.push(await append(state, absorbed, 'navigator', encodeMessage(i === 0 ? 'NO_GO' : 'REJECT', { cycle_id: 'done-cycle', feedback: `verbatim-critical-${i}` })));
    await drain.scheduler.kickMember(root, absorbed.id, 'navigator');
    const mixed = (await mailbox.readMailbox(state, absorbed.id, 'navigator')).filter(row => row.readAt !== undefined);
    check(mixed.filter(row => row.content.startsWith('[PAIR:GREEN]')).length === 30 && mixed.filter(row => row.content.includes('verbatim-critical')).length === 7 && urgent.slice(0, 7).every(row => drain.calls.at(-1).text.includes(row.content)), 'urgent burst keeps seven verbatim controls and one fair summary slot for all absorbed ordinary receipts');

    const generation = fixture('generation'); generation.members[0].id = 'old-generation'; await createTeamDir(state, generation);
    await append(state, generation, 'driver', 'old leased message');
    const oldEntered = deferred(), oldRelease = deferred(), newEntered = deferred(), newRelease = deferred();
    const hg = harness(root, async id => { if (id === 'old-generation') { oldEntered.resolve(); await oldRelease.promise; } else { newEntered.resolve(); await newRelease.promise; } return 'ok'; });
    const oldFlight = hg.scheduler.kickMember(root, generation.id, 'driver'); await entered(oldEntered.promise);
    const replacement = { ...generation.members[0], id: 'new-generation', joinedAt: 2 };
    check(await commitMemberReplacement(state, generation.id, generation.members[0], replacement), 'replacement test commits through the real guarded member replacement API');
    await retireSpawnedMembers(hg.ctx, hg.captain, state, [generation.members[0]]); hg.scheduler.releaseTeamSeats(['old-generation']);
    await append(state, generation, 'driver', 'new unleased message');
    const newFlight = hg.scheduler.kickMember(root, generation.id, 'driver');
    const replacementEntered = await entered(newEntered.promise);
    check(replacementEntered, 'replacement enters delivery immediately while retired predecessor admission is hung');
    oldRelease.resolve(); await oldFlight;
    check((await mailbox.readMailbox(state, generation.id, 'driver')).find(row => row.content === 'old leased message').readAt === undefined, 'retired admission never ACKs the old physical record into its successor');
    await append(state, generation, 'driver', 'while replacement hangs');
    const replacementDuplicate = hg.scheduler.kickMember(root, generation.id, 'driver');
    await new Promise(resolve => setImmediate(resolve));
    check(!replacementEntered || hg.calls.filter(row => row.childId === 'new-generation').length === 1, 'old flight completion cannot clear the replacement current flight');
    newRelease.resolve(); await Promise.all([newFlight, replacementDuplicate]);
    check((await mailbox.readUnreadMailbox(state, generation.id, 'driver')).length === 0, 'the successor seat drains the record the retired flight could not ACK, on the re-armed wake instead of the next sweep');

    const turn = fixture('turn-generation'); turn.members[0].id = 'turn-driver'; await createTeamDir(state, turn);
    const turnEntered = deferred(), turnRelease = deferred(), idleDone = deferred();
    const he = harness(root, async () => { turnEntered.resolve(); await turnRelease.promise; return 'ok'; });
    const liveAgent = { id: 'turn-driver', status: 'running', session: { header: { cwd: root } } }; he.statuses.set(liveAgent.id, liveAgent);
    const oldKick = he.scheduler.kickMember; he.scheduler.kickMember = async (...args) => { await oldKick(...args); idleDone.resolve(); };
    const oldNotice = deliverProtocolMessage(he.ctx, he.config, he.caller, turn, 'driver', encodeMessage('NO_GO', { feedback: 'old turn' }), {});
    await entered(turnEntered.promise);
    liveAgent.status = 'idle'; he.handlers.get('agent/status')({ agent: liveAgent, status: 'idle' });
    liveAgent.status = 'running'; he.handlers.get('agent/status')({ agent: liveAgent, status: 'running' });
    await entered(idleDone.promise); turnRelease.resolve(); await oldNotice;
    await deliverProtocolMessage(he.ctx, he.config, he.caller, turn, 'driver', encodeMessage('REJECT', { severity: 'P0', feedback: 'new turn urgent' }), {});
    check(he.calls.length === 2, 'late old-turn admission cannot suppress the first urgent notification after actual idle/running status edges');
    await deliverProtocolMessage(he.ctx, he.config, he.caller, turn, 'driver', encodeMessage('NO_GO', { feedback: 'same new turn' }), {});
    check(he.calls.length === 2 && (await mailbox.readUnreadMailbox(state, turn.id, 'driver')).length === 1, 'repeated urgent mail in that same running turn remains durable and deferred');

    const captainTurn = fixture('captain-turn-generation'); captainTurn.captainSessionId = 'edge-cap'; await createTeamDir(state, captainTurn);
    const hcEdge = harness(root, undefined, 'edge-cap'); hcEdge.captain.status = 'running';
    const captainIdleDone = deferred(), captainOldKick = hcEdge.scheduler.kickCaptain;
    hcEdge.scheduler.kickCaptain = async (...args) => { await captainOldKick(...args); captainIdleDone.resolve(); };
    const ackRelease = deferred(); let ackLock;
    hcEdge.captain.steer = message => {
      hcEdge.captainCalls.push(message.content[0].text);
      if (ackLock !== undefined) return;
      ackLock = withLock(teamLockKey(state, captainTurn.id), () => ackRelease.promise);
      hcEdge.captain.status = 'idle'; hcEdge.handlers.get('agent/status')({ agent: hcEdge.captain, status: 'idle' });
      hcEdge.captain.status = 'running'; hcEdge.handlers.get('agent/status')({ agent: hcEdge.captain, status: 'running' });
    };
    const oldCaptainNotice = deliverProtocolMessage(hcEdge.ctx, hcEdge.config, hcEdge.caller, captainTurn, 'captain', encodeMessage('NO_GO', { feedback: 'old captain turn' }), {});
    await entered(captainIdleDone.promise); ackRelease.resolve(); await oldCaptainNotice; await ackLock;
    await deliverProtocolMessage(hcEdge.ctx, hcEdge.config, hcEdge.caller, captainTurn, 'captain', encodeMessage('REJECT', { severity: 'P1', feedback: 'new captain turn' }), {});
    check(hcEdge.captainCalls.length === 2, 'captain synchronous idle/running edges reset suppression even while its asynchronous idle handler sees a running captain and ACK waits');
    await deliverProtocolMessage(hcEdge.ctx, hcEdge.config, hcEdge.caller, captainTurn, 'captain', encodeMessage('NO_GO', { feedback: 'same captain turn' }), {});
    check(hcEdge.captainCalls.length === 2, 'captain keeps the one-urgent-admission limit in the new turn');
  } finally { await rm(root, { recursive: true, force: true }); }
}
