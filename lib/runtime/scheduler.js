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
import { deliverToMember } from './members.js';
import { collapseUnread } from './collapse.js';
import {
  beginTaskAttempt,
  findTeamByParticipant,
  readTeam,
  unsatisfiedDependencies,
  writeTeam,
} from '../state/store.js';
import {
  acknowledgeMailbox,
  claimMailboxDelivery,
  readUnreadMailbox,
  releaseMailboxDelivery,
} from '../state/mailbox.js';
import { withLock } from '../state/lock.js';
import { stateRootOf, teamLockKey } from '../state/layout.js';
import { registerWakeRuntime } from './wake.js';
import { workspaceOf } from '../tools/shared.js';
import { recycleMember } from './recycle.js';
import { stallDiagnosis, stallEscalation, lastProgressAt } from '../protocol/stall.js';
import { nextObligation, obligationLine } from '../protocol/obligation.js';
import { steerCaptain } from '../tools/shared.js';
import { appendPairEvent } from '../events.js';

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
function nextReadyTask(tasks, memberName) {
  const ready = tasks.filter(task => task.status === 'pending'
    && (task.assignee === undefined || task.assignee === memberName)
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

export function fallbackMailboxPrompt(messages, collapsed) {
  return [
    'Pair-programming delivered messages that were persisted while live delivery was unavailable:',
    ...(collapsed !== undefined ? [collapsed] : []),
    ...messages.map(message => `\nFrom ${message.from}:\n${message.content}`),
    '\nHandle these messages in this turn. Task assignments still require pair_task_claim and the current attempt_id.',
  ].join('\n');
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
async function settledQuiet(stateRoot, team) {
  if (team.protocol?.phase === 'RETRO') return true;
  const tasks = team.tasks ?? [];
  if (tasks.length === 0) return false;
  if (!tasks.every((t) => TERMINAL_TASK_STATUS.has(t.status))) return false;
  const live = (team.members ?? []).filter((m) => m.status !== 'removed' && m.id !== '');
  if (!live.every((m) => m.status === 'idle')) return false;
  if (nextObligation(team) !== undefined) return false;
  for (const m of live) {
    if ((await readUnreadMailbox(stateRoot, team.id, m.name)).length > 0) return false;
  }
  return true;
}

/** Install one scheduler and its member activity observer. */
export function installPairScheduler(ctx, config, hosts = {}) {
  const memberQueues = new Map();
  const parkedAttempts = new Map();
  /** Teams this process has touched: the heartbeat's sweep list (N5). */
  const activeTeams = new Map();
  /** Why the last sweep of each member declined — the record a silent return used to destroy. */
  const lastDecline = new Map();
  /** When each team was last reported stalled, so one quiet stretch yields one report. */
  const lastStallReport = new Map();
  const memberQueueKey = (stateRoot, teamId, memberName) => (`${stateRoot}\0${teamId}\0${memberName}`);
  const serializeMember = async (key, operation) => {
    const previous = memberQueues.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    memberQueues.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (memberQueues.get(key) === tail) memberQueues.delete(key);
    }
  };

  const runtime = {
    /** Put one team on the heartbeat's sweep list (called at pair_start and on every kick). */
    trackTeam(workspace, teamId) {
      activeTeams.set(`${workspace}\0${teamId}`, { workspace, teamId });
    },
    /** Take one team off the sweep list (pair_stop). */
    untrackTeam(workspace, teamId) {
      activeTeams.delete(`${workspace}\0${teamId}`);
    },
    /** The teams the heartbeat would sweep right now (diagnostics + tests). */
    trackedTeams() {
      return [...activeTeams.values()];
    },

    /**
     * Heartbeat sweep (N5 fallback): kick every tracked team once. Covers the
     * case where the recovery kick of a mailbox-only delivery itself failed —
     * a stalled protocol should cost one heartbeat, never the whole timebox.
     */
    async heartbeat() {
      for (const { workspace, teamId } of [...activeTeams.values()]) {
        const team = await readTeam(stateRootOf(workspace, config), teamId);
        if (team === undefined) { activeTeams.delete(`${workspace}\0${teamId}`); continue; }
        if (team.protocol?.phase === 'DONE') { activeTeams.delete(`${workspace}\0${teamId}`); continue; }
        if (await settledQuiet(stateRootOf(workspace, config), team)) { activeTeams.delete(`${workspace}\0${teamId}`); continue; }
        await runtime.kickTeam(workspace, teamId);
        await runtime.escalateIfStalled(workspace, teamId);
      }
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
      const owed = nextObligation(fresh);
      const diagnosis = stallDiagnosis(fresh, { unread, obligation: owed });
      if (!diagnosis.stalled) return diagnosis;
      // One report per quiet stretch. Every heartbeat would be noise the
      // captain learns to skim, which is silence with extra steps.
      const key = workspace + '\0' + teamId;
      const already = lastStallReport.get(key);
      if (already !== undefined && already >= lastProgressAt(fresh.protocol)) return diagnosis;
      lastStallReport.set(key, Date.now());
      const declines = [...lastDecline.entries()]
        .filter(([k]) => k.startsWith(teamId + '\0'))
        .map(([k, v]) => '  ' + k.split('\0')[1] + ': ' + v.why);
      const NL = String.fromCharCode(10);
      const text = [
        stallEscalation(teamId, diagnosis, obligationLine(owed)),
        declines.length > 0 ? NL + 'Why the sweep could not clear it:' + NL + declines.join(NL) : '',
      ].filter(Boolean).join(NL);
      const captain = ctx.agents.get(fresh.captainSessionId);
      const delivered = captain !== undefined && steerCaptain(captain, 'scheduler', text);
      appendPairEvent(ctx, captain?.session, 'pair/stall', {
        teamId, quietMs: diagnosis.quietMs, idle: diagnosis.idle,
        waiting: diagnosis.waiting, owed: owed ?? null, delivered,
      });
      if (!delivered) {
        ctx.logger?.warn?.('pair-programming: team ' + teamId + ' is stalled and the captain is not reachable — ' + diagnosis.reason);
      }
      return diagnosis;
    },

    async kickTeam(workspace, teamId, suppliedCaptain) {
      const stateRoot = stateRootOf(workspace, config);
      const team = await readTeam(stateRoot, teamId);
      if (team === undefined) return;
      runtime.trackTeam(workspace, teamId);
      const captain = liveCaptain(ctx, team.captainSessionId, suppliedCaptain);
      if (captain === undefined) return;
      for (const member of team.members) {
        if (member.status === 'removed') continue;
        await runtime.kickMember(workspace, teamId, member.name, captain);
      }
    },

    async kickMember(workspace, teamId, memberName, suppliedCaptain) {
      const stateRoot = stateRootOf(workspace, config);
      runtime.trackTeam(workspace, teamId);
      const queueKey = memberQueueKey(stateRoot, teamId, memberName);
      // Every reason a sweep declines is now recorded. These used to be four
      // bare `return;`s, so a heartbeat that could do nothing did nothing
      // quietly, once a minute, forever — which is exactly how a board goes
      // silent and stays silent with mail pending.
      const declineKey = teamId + '\0' + memberName;
      const decline = (why) => { lastDecline.set(declineKey, { why, at: Date.now() }); };
      await serializeMember(queueKey, async () => {
        const team = await readTeam(stateRoot, teamId);
        if (team === undefined) return decline('team no longer exists');
        const captain = liveCaptain(ctx, team.captainSessionId, suppliedCaptain);
        if (captain === undefined) {
          return decline('the captain session is not live — a member is woken as a follow-up parented by the captain, so with the captain stopped nothing can restart this team from inside the plugin');
        }
        const member = team.members.find(c => c.name === memberName && c.status !== 'removed');
        if (member === undefined || member.id === '') return decline('no spawned seat by that name');
        if (!isMemberAvailable(ctx, member)) return decline('the seat is mid-turn');
        lastDecline.delete(declineKey);

        // A mailbox-only fallback is real pending work; deliver it before any
        // fresh task and acknowledge only after Harness accepts the follow-up.
        const unread = await readUnreadMailbox(stateRoot, team.id, member.name);
        if (unread.length > 0) {
          const ids = unread.map(m => m.id);
          await withLock(teamLockKey(stateRoot, team.id), () => claimMailboxDelivery(stateRoot, team.id, member.name, ids));
          const { collapsed, live } = collapseUnread(unread, team);
          const accepted = await deliverToMember(ctx, captain, member.id, fallbackMailboxPrompt(live, collapsed[0]), new AbortController().signal);
          await withLock(teamLockKey(stateRoot, team.id), () => (accepted
            ? acknowledgeMailbox(stateRoot, team.id, member.name, ids)
            : releaseMailboxDelivery(stateRoot, team.id, member.name, ids)));
          return;
        }

        const ticket = await withLock(teamLockKey(stateRoot, team.id), async () => {
          const fresh = await readTeam(stateRoot, team.id);
          if (fresh === undefined) return undefined;
          const currentMember = fresh.members.find(c => c.name === memberName && c.status !== 'removed');
          if (currentMember === undefined || currentMember.id === '' || !isMemberAvailable(ctx, currentMember)) return undefined;
          const owned = ownedOpenTask(fresh.tasks, currentMember.name);
          const parkedAttemptId = parkedAttempts.get(currentMember.id);
          const recoverOwned = owned !== undefined
            && (owned.attemptId === undefined || owned.attemptId !== parkedAttemptId);
          const task = recoverOwned ? owned : owned === undefined
            ? nextReadyTask(fresh.tasks, currentMember.name)
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
        const accepted = await deliverToMember(ctx, captain, ticket.memberId, assignmentPrompt(ticket, config.stateDir, team.id), new AbortController().signal);
        if (accepted) return;
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
    if (located.captainSessionId === agent.id) return;
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
      if (next === 'idle') {
        const owned = ownedOpenTask(fresh.tasks, current.name);
        if (owned?.attemptId === undefined) parkedAttempts.delete(agent.id);
        else parkedAttempts.set(agent.id, owned.attemptId);
      } else {
        parkedAttempts.delete(agent.id);
      }
      if (current.status === next) return;
      current.status = next;
      await writeTeam(stateRoot, fresh);
    });
    if (status === 'idle') {
      // R2: a seat whose cycle has been accepted is recycled here, on its own
      // idle edge — never from inside the tool call that accepted the cycle.
      if (hosts.selections !== undefined) {
        try {
          await recycleMember(ctx, config, hosts, stateRoot, located.id, member.name);
        } catch (error) {
          ctx.logger?.warn?.(`pair-programming: recycle of ${member.name} failed: ${String(error)}`);
        }
      }
      await runtime.kickMember(workspace, located.id, member.name);
    }
  };

  ctx.on('agent/status', ({ agent, status }) => {
    void syncMemberStatus(agent, status).catch((error) => {
      ctx.logger.warn(`pair-programming: member status scheduling failed for ${agent.id}: ${String(error)}`);
    });
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
