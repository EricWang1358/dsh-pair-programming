/**
 * Event-driven shared task scheduler.
 *
 * Adapted from @nanmicoder/dsh-agent-teams `lib/scheduler.js` (MIT). DSH
 * continuable agents expose explicit idle/running edges, so this scheduler
 * closes the "who works next" loop without keeping a polling turn alive:
 * every idle edge and every task-graph mutation attempts one atomic claim and
 * wakes the selected durable member. A resident member that becomes idle
 * while still owning an open attempt is parked; only an explicit captain
 * reassignment may rotate that capability.
 *
 * @module dsh-pair-programming/runtime/scheduler
 */
import { deliverToMember, installRetiredInboxGuard, seatModelRequest, isQuotaError, setNavRouteFallback } from './members.js';
import { markNavFallback } from '../integrations/nav-model.js';
import { installBoardWriteGuard } from './board-guard.js';
import { prepareMailboxDelivery, finishMailboxDelivery, coalesceDelivery, deliveryKey,
  observeDeliveryStatus, releaseDeliverySeats, boundedMailboxPrompt, selectDeliveryMessages } from './mail-delivery.js';
import {
  beginTaskAttempt,
  findTeamByParticipant,
  inspectTeams,
  readTeam,
  unsatisfiedDependencies,
  writeTeam,
} from '../state/store.js';
import { readUnreadMailbox, readMailbox } from '../state/mailbox.js';
import { withLock } from '../state/lock.js';
import { stateRootOf, teamLockKey } from '../state/layout.js';
import { registerWakeRuntime } from './wake.js';
import { workspaceOf } from '../tools/shared.js';
import { recycleMember } from './recycle.js';
import { stallDiagnosis, stallEscalation, lastProgressAt } from '../protocol/stall.js';
import { nextObligation, obligationLine } from '../protocol/obligation.js';
import { attentionSet, attentionLines, debtKey, wasTruncated, MAX_TOKEN_RESUMES } from '../protocol/attention.js';
import { wakeCaptain } from '../tools/shared.js';
import { appendPairEvent } from '../events.js';
import { createHeartbeat } from './heartbeat.js';
import { isDispatchClosed } from '../protocol/machine.js';

function liveCaptain(ctx, captainSessionId, supplied) {
  if (supplied !== undefined && supplied.id === captainSessionId) return supplied;
  return ctx.agents.get(captainSessionId);
}
function liveMember(ctx, member) {
  return ctx.agents.get(member.id);
}
function isMemberAvailable(ctx, member) {
  const live = liveMember(ctx, member);
  return live === undefined || live.status === 'idle';
}
function ownedOpenTask(tasks, memberName) {
  return tasks.find(task => task.assignee === memberName
    && (task.status === 'claimed' || task.status === 'in_progress'));
}
function nextReadyTask(tasks, memberName, role) {
  const ready = tasks.filter(task => task.status === 'pending'
    && (task.assignee === memberName || (role === 'driver' && task.assignee === undefined))
    && unsatisfiedDependencies(tasks, task.dependencies).length === 0);
  // Prefer tasks explicitly assigned to this member, then shared-pool tasks.
  return ready.find(t => t.assignee === memberName) ?? ready[0];
}

function assignmentPrompt(ticket, stateDir, teamId) {
  return [
    `[PAIR:INFO] You have been assigned task ${ticket.taskId}: ${ticket.subject}`,
    ticket.description !== undefined ? `\n${ticket.description}` : '',
    `\nCall pair_task_claim for ${ticket.taskId}; it returns this same attempt_id=${ticket.attemptId}. Include it in every pair_task_update for this attempt. If rejected as stale, stop — the task was reassigned. Work only this task this turn, run one Pair Cycle at a time, then become idle so the scheduler can select your next ready task.`,
    `\nTeam state (read-only) under ${stateDir}/${teamId}/.`,
  ].join('\n');
}

/** Legacy formatter entry point; delivery itself must use atomic preparation. */
export function fallbackMailboxPrompt(messages) {
  return boundedMailboxPrompt(selectDeliveryMessages(messages), { protocol: { cycles: [] } }, undefined, {}, messages.length).text;
}

const TERMINAL_TASK_STATUS = new Set(['completed', 'failed', 'cancelled']);

/**
 * Whether a team is thoroughly finished and may leave the heartbeat sweep
 * list: every task terminal, every live seat idle, no pending mail, no owed
 * step (RETRO counts as settled — the machine only leaves it for DONE).
 * Fresh teams (no tasks yet) never count: pair_start tracks explicitly so a
 * protocol that stalls before its first kick stays recoverable. Untracking is
 * self-healing — kickTeam, kickMember, task creation and mailbox recovery all
 * re-track first — so a settled team that grows new work rejoins the sweep.
 */
async function settledQuiet(stateRoot, team, config) {
  if (team.protocol?.phase === 'RETRO') return true;
  const tasks = team.tasks ?? [];
  if (tasks.length === 0) return false;
  if (!tasks.every((t) => TERMINAL_TASK_STATUS.has(t.status))) return false;
  const live = (team.members ?? []).filter((m) => m.status !== 'removed' && m.id !== '');
  if (!live.every((m) => m.status === 'idle')) return false;
  if (nextObligation(team, undefined, { oracleFirst: config.oracleFirst }) !== undefined) return false;
  for (const recipient of ['captain', ...live.map(member => member.name)]) {
    // Leased-but-unacknowledged records also need a future sweep if the host
    // crashes. Excluding them could untrack the team before lease expiry.
    if ((await readMailbox(stateRoot, team.id, recipient)).some(message => message.readAt === undefined)) return false;
  }
  return true;
}

/**
 * How long a workspace recovery scan may be reused.
 *
 * Long enough to coalesce the session-start burst of a host coming up, short
 * enough that no resume is served a phase the board has since left.
 */
const RECOVERY_SCAN_TTL_MS = 5_000;

/** Install one scheduler and its member activity observer. */
export function installPairScheduler(ctx, config, hosts = {}) {
  installRetiredInboxGuard(ctx, config);
  installBoardWriteGuard(ctx, config);
  const parkedAttempts = new Map();
  const mailDiagnostics = new Map();
  /** Teams this process has touched: the heartbeat's sweep list (N5). */
  const activeTeams = new Map();
  /** Why the last sweep of each member declined — the record a silent return used to destroy. */
  const lastDecline = new Map();
  /** When each team was last reported stalled, so one quiet stretch yields one report. */
  const lastStallReport = new Map();
  /** Live session activity sampled by status edges and watchdog sweeps. */
  const memberActivity = new Map();
  /** The last obligation each seat was nudged about, so one debt = one nudge. */
  const lastNudge = new Map();
  let disposed = false;
  const lifetime = new AbortController();
  /**
   * Recovery scans, memoised only long enough to coalesce the burst of
   * session-starts a host emits while it comes up.
   *
   * Memoising them for the life of the process was wrong: the snapshot records
   * a phase, and a team that reaches DONE after the scan would still be
   * re-tracked from the stale entry on the captain's next resume. The sweep
   * untracks it again, so it self-heals — but a cache that can hand back a
   * phase which is known to be false is a stale read, not a design.
   */
  const recoveryScans = new Map();
  const recoveryScanTtlMs = hosts.recoveryScanTtlMs ?? RECOVERY_SCAN_TTL_MS;

  const runtime = {
    /** Put one team on the heartbeat's sweep list (called at pair_start and on every kick). */
    trackTeam(workspace, teamId) {
      if (disposed) return;
      activeTeams.set(`${workspace}\0${teamId}`, { workspace, teamId });
    },
    /** Take one team off the sweep list (pair_stop). */
    /**
     * Release every process-local entry keyed to one team's seats.
     *
     * `lastNudge` and `memberActivity` are keyed by CHILD SESSION ID, and with
     * `memberLifetime: 'cycle'` a fresh id is minted on every accepted cycle —
     * so both grew for the life of the process, one entry per seat that ever
     * existed, with nothing ever removing them. Each entry is small, so this is
     * not what exhausts a heap; it is unbounded by construction, which is the
     * part worth fixing. A team that stops should give back everything held on
     * its behalf.
     */
    releaseTeamSeats(seatIds, teamId) {
      releaseDeliverySeats(ctx, seatIds ?? [], teamId);
      for (const id of seatIds ?? []) {
        if (typeof id !== 'string' || id === '') continue;
        lastNudge.delete(id);
        memberActivity.delete(id);
        parkedAttempts.delete(id);
      }
      if (typeof teamId === 'string') {
        const prefix = `${teamId}\0`;
        for (const key of [...lastDecline.keys()]) {
          if (key.startsWith(prefix)) lastDecline.delete(key);
        }
        for (const key of mailDiagnostics.keys()) if (key.startsWith(prefix)) mailDiagnostics.delete(key);
      }
    },
    untrackTeam(workspace, teamId) {
      lastStallReport.delete(`${workspace}\0${teamId}`);
      activeTeams.delete(`${workspace}\0${teamId}`);
    },
    /** The teams the heartbeat would sweep right now (diagnostics + tests). */
    trackedTeams() {
      return [...activeTeams.values()];
    },
    diagnostics() {
      return { trackedTeams: activeTeams.size, heartbeat: heartbeat.health(),
        seatEntries: { nudges: lastNudge.size, activity: memberActivity.size, parked: parkedAttempts.size },
        mail: [...mailDiagnostics.values()] };
    },

    /**
     * Heartbeat sweep (N5 fallback): kick every tracked team once. Covers the
     * case where the recovery kick of a mailbox-only delivery itself failed —
     * a stalled protocol should cost one heartbeat, never the whole timebox.
     */
    async heartbeat() {
      return heartbeat.sweep();
    },

    /**
     * A sweep that could not move anything must say so to the one party able
     * to act. Silence here is the whole bug: the plugin cannot restart a
     * conversation the harness has ended, so its duty is to be loud rather
     * than to keep trying quietly.
     */
    async escalateIfStalled(workspace, teamId) {
      const stateRoot = stateRootOf(workspace, config);
      const fresh = await readTeam(stateRoot, teamId);
      if (fresh === undefined) return undefined;
      const unread = {};
      for (const m of fresh.members ?? []) {
        if (m.status === 'removed' || m.id === '') continue;
        unread[m.name] = (await readUnreadMailbox(stateRoot, teamId, m.name)).length;
      }
      const owed = nextObligation(fresh, undefined, { oracleFirst: config.oracleFirst });
      const diagnosis = stallDiagnosis(fresh, { unread, obligation: owed, workingLeaseMs: config.workingLeaseMs });
      if (!diagnosis.stalled) return diagnosis;
      // One report per quiet stretch. Every heartbeat would be noise the
      // captain learns to skim, which is silence with extra steps.
      const key = workspace + '\0' + teamId;
      const already = lastStallReport.get(key);
      if (already !== undefined && already >= lastProgressAt(fresh.protocol)) return diagnosis;
      const declines = [...lastDecline.entries()]
        .filter(([k]) => k.startsWith(teamId + '\0'))
        .map(([k, v]) => '  ' + k.split('\0')[1] + ': ' + v.why);
      const NL = String.fromCharCode(10);
      const text = [
        stallEscalation(teamId, diagnosis, obligationLine(owed)),
        NL + attentionLines(attentionSet(fresh, { maxResumes: config.maxTokenResumes, oracleFirst: config.oracleFirst })),
        declines.length > 0 ? NL + 'Why the sweep could not clear it:' + NL + declines.join(NL) : '',
      ].filter(Boolean).join(NL);
      const captain = ctx.agents.get(fresh.captainSessionId);
      const wakeKey = `${teamId}:${fresh.updatedAt}:${owed?.tool ?? 'rest'}:${diagnosis.expiredWorking?.join(',') ?? 'idle'}`;
      const delivered = captain !== undefined && wakeCaptain(captain, 'scheduler', text, wakeKey);
      if (delivered) lastStallReport.set(key, Date.now());
      appendPairEvent(ctx, captain?.session, 'pair/stall', {
        teamId, quietMs: diagnosis.quietMs, idle: diagnosis.idle,
        waiting: diagnosis.waiting, owed: owed ?? null, delivered,
      });
      if (!delivered) {
        ctx.logger?.warn?.('pair-programming: team ' + teamId + ' is stalled and the captain is not reachable — ' + diagnosis.reason);
      }
      return diagnosis;
    },

    async kickTeam(workspace, teamId, suppliedCaptain, signal) {
      if (disposed || signal?.aborted) return;
      const stateRoot = stateRootOf(workspace, config);
      const team = await readTeam(stateRoot, teamId);
      if (team === undefined || isDispatchClosed(team.protocol.phase)) return;
      runtime.trackTeam(workspace, teamId);
      const captain = liveCaptain(ctx, team.captainSessionId, suppliedCaptain);
      if (captain === undefined) return;
      const members = team.members.filter(member => member.status !== 'removed');
      const results = await Promise.allSettled([
        ...members.map(member => runtime.kickMember(workspace, teamId, member.name, captain, signal)),
        runtime.kickCaptain(workspace, teamId, captain, signal),
      ]);
      results.forEach((result, index) => {
        if (result.status === 'rejected') ctx.logger?.warn?.(`pair-programming: kick ${members[index]?.name ?? 'captain'} failed: ${String(result.reason)}`);
      });
    },

    /** Captain recovery is mail-only: never claim implementation work here. */
    async kickCaptain(workspace, teamId, suppliedCaptain, signal) {
      signal = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal]);
      if (disposed || signal.aborted) return;
      const stateRoot = stateRootOf(workspace, config);
      const selectedId = (await readTeam(stateRoot, teamId))?.captainSessionId;
      const key = deliveryKey(stateRoot, teamId, 'captain', selectedId);
      runtime.trackTeam(workspace, teamId);
      await coalesceDelivery(ctx, key, async () => {
        const team = await readTeam(stateRoot, teamId);
        if (team === undefined || isDispatchClosed(team.protocol.phase) || signal.aborted) return;
        const captain = liveCaptain(ctx, team.captainSessionId, suppliedCaptain);
        if (captain === undefined || captain.id !== selectedId || captain.status !== 'idle') return;
        observeDeliveryStatus(captain);
        const batch = await prepareMailboxDelivery(stateRoot, teamId, 'captain', config, { memberId: captain.id, captainId: captain.id, signal });
        if (batch === undefined) return;
        let accepted = false;
        try { accepted = wakeCaptain(captain, 'scheduler', batch.text, batch.claimId, { envelope: false }); }
        finally { accepted = await finishMailboxDelivery(stateRoot, batch, accepted, signal); }
        mailDiagnostics.set(`${teamId}\0captain`, { teamId, member: 'captain', selected: batch.count, physicalCount: batch.physicalCount, bytes: batch.bytes,
          backlog: batch.backlog + (accepted ? 0 : batch.physicalCount), accepted, at: Date.now() });
        if (!accepted) lastDecline.set(`${teamId}\0captain`, { why: 'captain durable mail notification was refused or cancelled', at: Date.now() });
        else lastDecline.delete(`${teamId}\0captain`);
      });
    },

    /** Persist only coarse activity, never streamed content. */
    async sampleMemberActivity(workspace, teamId) {
      const stateRoot = stateRootOf(workspace, config);
      const team = await readTeam(stateRoot, teamId);
      if (team === undefined) return;
      let changed = false;
      const now = Date.now();
      for (const member of team.members ?? []) {
        if (member.status !== 'working' || member.id === '') continue;
        const live = liveMember(ctx, member);
        const seq = live?.session?.seq;
        const prior = memberActivity.get(member.id);
        if (typeof seq === 'number' && (prior === undefined || prior.seq !== seq)) {
          memberActivity.set(member.id, { seq, at: now });
          member.activity = { ...(member.activity ?? {}), lastActivityAt: now, lastSeq: seq };
          changed = true;
        }
      }
      if (changed) await withLock(teamLockKey(stateRoot, teamId), async () => {
        const fresh = await readTeam(stateRoot, teamId);
        if (fresh === undefined) return;
        for (const member of fresh.members ?? []) {
          const sampled = memberActivity.get(member.id);
          if (sampled === undefined || member.status !== 'working') continue;
          member.activity = { ...(member.activity ?? {}), lastActivityAt: sampled.at, lastSeq: sampled.seq };
        }
        await writeTeam(stateRoot, fresh);
      });
    },

    async kickMember(workspace, teamId, memberName, suppliedCaptain, signal) {
      signal = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal]);
      if (disposed || signal?.aborted) return;
      const stateRoot = stateRootOf(workspace, config);
      runtime.trackTeam(workspace, teamId);
      const selectedId = (await readTeam(stateRoot, teamId))?.members.find(member => member.name === memberName && member.status !== 'removed')?.id;
      const queueKey = deliveryKey(stateRoot, teamId, memberName, selectedId);
      // Every reason a sweep declines is now recorded. These used to be four
      // bare `return;`s, so a heartbeat that could do nothing did nothing
      // quietly, once a minute, forever — which is exactly how a board goes
      // silent and stays silent with mail pending.
      const declineKey = teamId + '\0' + memberName;
      const decline = (why) => { lastDecline.set(declineKey, { why, at: Date.now() }); };
      await coalesceDelivery(ctx, queueKey, async () => {
        if (disposed || signal?.aborted) return;
        let team = await readTeam(stateRoot, teamId);
        if (team === undefined) return decline('team no longer exists');
        if (disposed || signal?.aborted || isDispatchClosed(team.protocol.phase)) return;
        const captain = liveCaptain(ctx, team.captainSessionId, suppliedCaptain);
        if (captain === undefined) {
          return decline('the captain session is not live — a member is woken as a follow-up parented by the captain, so with the captain stopped nothing can restart this team from inside the plugin');
        }
        let member = team.members.find(c => c.name === memberName && c.status !== 'removed');
        if (member === undefined || member.id === '' || member.id !== selectedId) return decline('no current spawned seat by that identity');
        if (!isMemberAvailable(ctx, member)) return decline('the seat is mid-turn');
        observeDeliveryStatus(liveMember(ctx, member));
        lastDecline.delete(declineKey);

        // A mailbox-only fallback is real pending work; deliver it before any
        // fresh task and acknowledge only after Harness accepts the follow-up.
        const batch = await prepareMailboxDelivery(stateRoot, team.id, member.name, config, { memberId: member.id, captainId: captain.id, signal });
        if (batch !== undefined) {
          let redelivery = { ok: false, reason: 'delivery interrupted' };
          try { redelivery = await deliverToMember(ctx, captain, member.id, batch.text, signal); }
          finally { redelivery.ok = await finishMailboxDelivery(stateRoot, batch, redelivery.ok, signal); }
          mailDiagnostics.set(declineKey, { teamId, member: memberName, selected: batch.count, physicalCount: batch.physicalCount, bytes: batch.bytes,
            backlog: batch.backlog + (redelivery.ok ? 0 : batch.physicalCount), accepted: redelivery.ok, at: Date.now() });
          // A failed redelivery used to return here having recorded NOTHING:
          // the mail went back to unread, the sweep tried again 120s later,
          // failed again, and the only visible artifact was a stall report that
          // could not say why. That is how a board stays quiet for 244s with
          // "Mail pending for: driver, navigator, challenger" and no cause
          // attached to it. Record the host's own refusal so the next report
          // carries it.
          if (!redelivery.ok) decline(`could not redeliver ${batch.count} queued message(s) — ${redelivery.reason}`);
          return;
        }

        // The seat owes the board a call and has nothing unread. This is not a
        // rare corner: it is what an accepted-but-inert host follow-up leaves
        // behind. deliverProtocolMessage acknowledges the mailbox as soon as
        // the host ACCEPTS the follow-up, so if that follow-up never becomes a
        // turn, the debt survives with an empty inbox and the branch above
        // finds nothing to redeliver.
        //
        // Until now nothing here covered that: the sweep fell through to task
        // assignment, found no ready task, and returned. The only recovery was
        // escalateIfStalled steering the CAPTAIN, which is why a live session
        // had a captain hand-relaying every single step — the protocol text
        // forbids exactly that, and the runtime left it as the only thing that
        // worked. Tell the seat that owes the call, directly.
        team = await readTeam(stateRoot, teamId);
        if (team === undefined || isDispatchClosed(team.protocol.phase) || team.captainSessionId !== captain.id || signal?.aborted) return;
        const currentSeat = team.members.find(candidate => candidate.name === memberName && candidate.id === member.id && candidate.status !== 'removed');
        if (currentSeat === undefined || !isMemberAvailable(ctx, currentSeat)) return;
        member = currentSeat;
        const owed = nextObligation(team, member.name, { oracleFirst: config.oracleFirst });
        if (owed !== undefined && owed.who === member.name) {
          const debt = debtKey(team, owed);

          // Bounded resume (V5.1). A turn cut off at the output-token ceiling
          // ends NORMALLY: the seat goes idle, the board never moved, and the
          // ordinary nudge below is suppressed by its own dedupe because the
          // debt key is unchanged — so the work simply stops with nobody
          // wrong. Continuing is right, but only while it is bounded: the same
          // seat, cut off on the same owed call, twice, is a loop that bills
          // for itself. Past the budget the seat is parked and the captain
          // owns it (the attention set says so in the same words).
          if (wasTruncated(member)) {
            const spent = member.resume?.debt === debt ? Number(member.resume?.count ?? 0) : 0;
            const budget = Number(config.maxTokenResumes ?? MAX_TOKEN_RESUMES);
            if (spent >= budget) {
              return decline(`the seat was truncated at the token ceiling ${spent} time(s) on ${owed.tool} without moving the board — the bounded resume budget is spent, so this is now a captain ruling`);
            }
            await withLock(teamLockKey(stateRoot, team.id), async () => {
              const fresh = await readTeam(stateRoot, team.id);
              const current = fresh?.members.find(c => c.name === memberName && c.status !== 'removed');
              if (fresh === undefined || current === undefined) return;
              current.resume = { debt, count: spent + 1, at: Date.now() };
              await writeTeam(stateRoot, fresh);
            });
            const resumed = await deliverToMember(ctx, captain, member.id, [
              'Pair-programming: your last turn was cut off at the output-token ceiling, not finished.',
              '',
              obligationLine(owed, member.name),
              '',
              `Continue from the CURRENT board state — do not restart the work and do not re-derive what is already recorded. Read pair_status first, then make that one call. This is bounded resume ${spent + 1} of ${budget}; after that the captain rules on it instead.`,
            ].join(String.fromCharCode(10)), signal);
            if (resumed.ok) {
              lastNudge.set(member.id, debt);
              return;
            }
            decline(`the truncated seat could not be resumed — ${resumed.reason}`);
            return;
          }

          if (lastNudge.get(member.id) !== debt) {
            lastNudge.set(member.id, debt);
            const nudge = await deliverToMember(ctx, captain, member.id, [
              'Pair-programming: the board has been waiting on you.',
              '',
              obligationLine(owed, member.name),
              '',
              'Read pair_status first — the board outranks any older instruction — then make that call in this turn.',
            ].join(String.fromCharCode(10)), signal);
            if (nudge.ok) return;
            lastNudge.delete(member.id); // it never landed; let the next sweep retry
            decline(`the owed seat could not be woken for its own step — ${nudge.reason}`);
          }
          // One stable debt (including future oracle drafts) gets one nudge.
          // Do not turn its dedupe into a task auto-claim on the next heartbeat.
          return;
        }

        const ticket = await withLock(teamLockKey(stateRoot, team.id), async () => {
          if (disposed || signal?.aborted) return;
          const fresh = await readTeam(stateRoot, team.id);
          if (fresh === undefined || isDispatchClosed(fresh.protocol.phase)) return undefined;
          const currentMember = fresh.members.find(c => c.name === memberName && c.status !== 'removed');
          if (currentMember === undefined || currentMember.id === '' || currentMember.role === 'spec' || !isMemberAvailable(ctx, currentMember)) return undefined;
          const owned = ownedOpenTask(fresh.tasks, currentMember.name);
          const parkedAttemptId = parkedAttempts.get(currentMember.id);
          const recoverOwned = owned !== undefined
            && (owned.attemptId === undefined || owned.attemptId !== parkedAttemptId);
          const task = recoverOwned ? owned : owned === undefined
            ? nextReadyTask(fresh.tasks, currentMember.name, currentMember.role)
            : undefined;
          if (task === undefined) {
            if (currentMember.status !== 'idle') {
              currentMember.status = 'idle';
              await writeTeam(stateRoot, fresh);
            }
            return undefined;
          }
          const previousAssignee = task.assignee;
          const attemptId = beginTaskAttempt(task, currentMember.name);
          parkedAttempts.delete(currentMember.id);
          currentMember.status = 'working';
          await writeTeam(stateRoot, fresh);
          return {
            taskId: task.id,
            memberName: currentMember.name,
            memberId: currentMember.id,
            attemptId,
            previousAssignee,
            subject: task.subject,
            description: task.description,
          };
        });
        if (ticket === undefined) return;
        const assigned = await deliverToMember(ctx, captain, ticket.memberId, assignmentPrompt(ticket, config.stateDir, team.id), signal);
        if (assigned.ok) return;
        decline(`could not hand ${ticket.taskId} to the seat — ${assigned.reason}`);
        // Roll back only our exact failed dispatch; a concurrent captain
        // handoff has already changed the capability and wins.
        await withLock(teamLockKey(stateRoot, team.id), async () => {
          const fresh = await readTeam(stateRoot, team.id);
          if (fresh === undefined) return;
          const task = fresh.tasks.find(c => c.id === ticket.taskId);
          if (task?.attemptId !== ticket.attemptId) return;
          task.status = 'pending';
          task.assignee = ticket.previousAssignee;
          task.attemptId = undefined;
          task.handoffId = undefined;
          task.updatedAt = Date.now();
          const currentMember = fresh.members.find(c => c.name === ticket.memberName);
          if (currentMember !== undefined && currentMember.status !== 'removed') currentMember.status = 'idle';
          await writeTeam(stateRoot, fresh);
        });
      });
    },
  };

  const syncMemberStatus = async (agent, status) => {
    const workspace = workspaceOf(agent);
    const stateRoot = stateRootOf(workspace, config);
    const located = await findTeamByParticipant(stateRoot, agent.id);
    if (located === undefined) {
      parkedAttempts.delete(agent.id);
      return;
    }
    if (located.captainSessionId === agent.id) {
      if (status === 'idle') await runtime.kickCaptain(workspace, located.id, agent);
      return;
    }
    const member = located.members.find(c => c.id === agent.id && c.status !== 'removed');
    if (member === undefined) {
      parkedAttempts.delete(agent.id);
      return;
    }
    await withLock(teamLockKey(stateRoot, located.id), async () => {
      const fresh = await readTeam(stateRoot, located.id);
      const current = fresh?.members.find(c => c.id === agent.id && c.status !== 'removed');
      if (fresh === undefined || current === undefined) return;
      const next = status === 'running' ? 'working' : 'idle';
      const now = Date.now();
      const seq = typeof agent.session?.seq === 'number' ? agent.session.seq : undefined;
      if (next === 'working') {
        current.activity = { startedAt: now, lastActivityAt: now, ...(seq === undefined ? {} : { startSeq: seq, lastSeq: seq }) };
        memberActivity.set(agent.id, { seq, at: now });
      } else {
        const events = typeof agent.session?.snapshotEvents === 'function'
          ? agent.session.snapshotEvents(current.activity?.startSeq ?? 0)
          : [];
        const end = [...events].reverse().find(event => event.type === 'turn/end');
        const tools = events.filter(event => event.type === 'tool/call');
        const pairTools = tools.filter(event => String(event.data?.name ?? '').startsWith('pair_'));
        current.lastTurn = {
          startedAt: current.activity?.startedAt ?? now,
          endedAt: now,
          endReason: end?.data?.reason ?? 'idle',
          toolCalls: tools.length,
          boardMutations: pairTools.length,
          empty: pairTools.length === 0,
        };
        current.activity = { ...(current.activity ?? {}), lastActivityAt: now, ...(seq === undefined ? {} : { lastSeq: seq }) };
        memberActivity.delete(agent.id);
      }
      if (next === 'idle') {
        const owned = ownedOpenTask(fresh.tasks, current.name);
        if (owned?.attemptId === undefined) parkedAttempts.delete(agent.id);
        else parkedAttempts.set(agent.id, owned.attemptId);
      } else {
        parkedAttempts.delete(agent.id);
      }
      current.status = next;
      await writeTeam(stateRoot, fresh);
    });
    if (status === 'idle') {
      // R2: a seat whose cycle has been accepted is recycled here, on its own
      // idle edge — never from inside the tool call that accepted the cycle.
      if (hosts.selections !== undefined) {
        try {
          await recycleMember(ctx, config, { ...hosts, releaseTeamSeats: runtime.releaseTeamSeats }, stateRoot, located.id, member.name, { signal: lifetime.signal });
        } catch (error) {
          ctx.logger?.warn?.(`pair-programming: recycle of ${member.name} failed: ${String(error)}`);
        }
      }
      await runtime.kickMember(workspace, located.id, member.name);
    }
  };

  ctx.on('agent/status', ({ agent, status }) => {
    if (disposed) return;
    observeDeliveryStatus(agent, status);
    void syncMemberStatus(agent, status).catch((error) => {
      ctx.logger.warn(`pair-programming: member status scheduling failed for ${agent.id}: ${String(error)}`);
    });
  });

  ctx.on?.('agent/error', ({ agent, error }) => {
    if (disposed) return;
    void (async () => {
      const workspace = workspaceOf(agent);
      const stateRoot = stateRootOf(workspace, config);
      const team = await findTeamByParticipant(stateRoot, agent.id);
      if (team === undefined || team.captainSessionId === agent.id) return;
      // The fallback facts are captured INSIDE the lock (member is block-scoped
      // there) and consumed OUTSIDE it — referencing member here was exactly
      // the ReferenceError the outer catch once swallowed into a missing wake.
      let fallbackRole = undefined;
      let fallbackName = undefined;
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        const member = fresh?.members.find(item => item.id === agent.id && item.status !== 'removed');
        if (fresh === undefined || member === undefined) return;
        member.lastTurn = { ...(member.lastTurn ?? {}), endedAt: Date.now(), endReason: 'error', lastError: String(error) };
        fallbackRole = member.role;
        fallbackName = member.name;
        await writeTeam(stateRoot, fresh);
      });
      // Quota fallback (M20): the acceptance seat died mid-turn on its premium
      // route — respawn it on the captain's route immediately (the board holds
      // every committed message; the respawn reads the protocol from there)
      // and mark the card, so the fallback is visible where the field lives.
      const request = seatModelRequest(config, fallbackRole);
      if (fallbackRole !== undefined && request.model !== undefined && isQuotaError(String(error))) {
        // Both markers are DISPLAY. The respawn and the captain wake below are
        // the recovery. Marking used to throw (see markNavFallback), which
        // aborted this whole block before either ran — the seat was never
        // respawned on the captain's route and the captain was never told,
        // while the outer handler logged "telemetry failed" at warn level.
        // Ordering alone would not have saved it, so each marker is contained
        // here as well: a display failure may cost a badge, never a recovery.
        try {
          setNavRouteFallback('模型 ' + request.provider + '/' + request.model + ' 用量耗尽（'
            + String(error).slice(0, 160) + '）——' + fallbackRole + ' 席位已回退为队长模型与配置');
          markNavFallback();
        } catch (markError) {
          ctx.logger?.warn?.('pair-programming: quota fallback marker failed (recovery continues): ' + String(markError));
        }
        try {
          await recycleMember(ctx, config, { ...hosts, releaseTeamSeats: runtime.releaseTeamSeats }, stateRoot, team.id, fallbackName, { force: true, signal: lifetime.signal });
        } catch (recycleError) {
          ctx.logger?.warn?.('pair-programming: quota fallback recycle of ' + fallbackName + ' failed: ' + String(recycleError));
        }
      }
      const captain = ctx.agents.get(team.captainSessionId);
      wakeCaptain(captain, 'scheduler', `[PAIR:MEMBER_ERROR] ${team.members.find(m => m.id === agent.id)?.name ?? agent.id}: ${String(error)}. Read pair_status and reassign, retry, or abort explicitly.`, `${team.id}:${team.updatedAt}:member-error:${agent.id}:${String(error)}`);
    })().catch(error2 => ctx.logger?.warn?.(`pair-programming: member error telemetry failed: ${String(error2)}`));
  });

  const heartbeat = createHeartbeat({
    entries: () => [...activeTeams.values()],
    budgetMs: hosts.heartbeatBudgetMs ?? 10_000,
    onError: ({ workspace, teamId }, error) => ctx.logger?.warn?.(`pair-programming: heartbeat ${workspace}/${teamId} failed: ${String(error)}`),
    run: async ({ workspace, teamId }, signal) => {
      signal.throwIfAborted();
      const team = await readTeam(stateRootOf(workspace, config), teamId);
      if (team === undefined || ['DONE', 'ABORTED'].includes(team.protocol.phase)) {
        runtime.untrackTeam(workspace, teamId); return;
      }
      signal.throwIfAborted();
      await runtime.sampleMemberActivity(workspace, teamId);
      signal.throwIfAborted();
      if (await settledQuiet(stateRootOf(workspace, config), team, config)) { runtime.untrackTeam(workspace, teamId); return; }
      signal.throwIfAborted();
      await runtime.kickTeam(workspace, teamId, undefined, signal);
      signal.throwIfAborted();
      await runtime.escalateIfStalled(workspace, teamId);
    },
  });
  // A resumed captain need not send a new message to rejoin the sweep list.
  // Scan only that session's workspace; never discover arbitrary directories.
  ctx.on?.('agent/session-start', async ({ agent }) => {
    const workspace = agent.session?.header?.cwd;
    if (disposed || typeof workspace !== 'string') return;
    try {
      const cached = recoveryScans.get(workspace);
      let scan = cached !== undefined && Date.now() - cached.at < recoveryScanTtlMs ? cached.scan : undefined;
      if (scan === undefined) {
        scan = inspectTeams(stateRootOf(workspace, config)).then(snapshot => ({
          ...snapshot, teams: snapshot.teams.filter(t => !['DONE', 'ABORTED'].includes(t.protocol.phase))
            .map(t => ({ id: t.id, captainSessionId: t.captainSessionId, protocol: { phase: t.protocol.phase } })),
        }));
        const entry = { scan, at: Date.now() };
        recoveryScans.set(workspace, entry);
        if (recoveryScans.size > 256) recoveryScans.delete(recoveryScans.keys().next().value);
        void scan.catch(() => { if (recoveryScans.get(workspace) === entry) recoveryScans.delete(workspace); });
      }
      const snapshot = await scan;
      if (!snapshot.complete) recoveryScans.delete(workspace);
      // A team that settles is untracked by the sweep; do not let a snapshot
      // taken before that put it back on the list on the next resume.
      for (const team of snapshot.teams) {
        if (team.captainSessionId === agent.id && !['DONE', 'ABORTED'].includes(team.protocol.phase)) runtime.trackTeam(workspace, team.id);
      }
      for (const { teamId, error } of snapshot.errors) ctx.logger?.warn?.(`pair-programming: recovery ${workspace}/${teamId}: ${error}`);
    } catch (error) { ctx.logger?.warn?.(`pair-programming: recovery discovery failed: ${String(error)}`); }
  });
  ctx.on?.('dispose', () => {
    disposed = true;
    lifetime.abort(new Error('scheduler disposed'));
    heartbeat.dispose();
    activeTeams.clear(); lastStallReport.clear(); lastDecline.clear();
    recoveryScans.clear();
    lastNudge.clear(); memberActivity.clear(); parkedAttempts.clear(); mailDiagnostics.clear();
  });

  // N5 heartbeat: the last line of defence against a protocol that went quiet.
  // `heartbeatMs = 0` disables it (unit tests drive `runtime.heartbeat()` directly).
  const period = Number(config.heartbeatMs ?? 0);
  if (Number.isFinite(period) && period > 0) {
    const timer = setInterval(() => {
      void runtime.heartbeat().catch((error) => {
        ctx.logger?.warn?.(`pair-programming: heartbeat sweep failed: ${String(error)}`);
      });
    }, period);
    timer.unref?.();
    ctx.on?.('dispose', () => clearInterval(timer));
  }

  return registerWakeRuntime(ctx, runtime);
}
