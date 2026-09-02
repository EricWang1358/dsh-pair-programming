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

/** Install one scheduler and its member activity observer. */
export function installPairScheduler(ctx, config) {
  const memberQueues = new Map();
  const parkedAttempts = new Map();
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
    async kickTeam(workspace, teamId, suppliedCaptain) {
      const stateRoot = stateRootOf(workspace, config);
      const team = await readTeam(stateRoot, teamId);
      if (team === undefined) return;
      const captain = liveCaptain(ctx, team.captainSessionId, suppliedCaptain);
      if (captain === undefined) return;
      for (const member of team.members) {
        if (member.status === 'removed') continue;
        await runtime.kickMember(workspace, teamId, member.name, captain);
      }
    },

    async kickMember(workspace, teamId, memberName, suppliedCaptain) {
      const stateRoot = stateRootOf(workspace, config);
      const queueKey = memberQueueKey(stateRoot, teamId, memberName);
      await serializeMember(queueKey, async () => {
        const team = await readTeam(stateRoot, teamId);
        if (team === undefined) return;
        const captain = liveCaptain(ctx, team.captainSessionId, suppliedCaptain);
        if (captain === undefined) return;
        const member = team.members.find(c => c.name === memberName && c.status !== 'removed');
        if (member === undefined || member.id === '' || !isMemberAvailable(ctx, member)) return;

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
    const workspace = agent.session.header.cwd ?? process.cwd();
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
      await runtime.kickMember(workspace, located.id, member.name);
    }
  };

  ctx.on('agent/status', ({ agent, status }) => {
    void syncMemberStatus(agent, status).catch((error) => {
      ctx.logger.warn(`pair-programming: member status scheduling failed for ${agent.id}: ${String(error)}`);
    });
  });

  return runtime;
}
