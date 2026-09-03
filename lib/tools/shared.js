/**
 * Shared helpers for the pair_* tools: caller resolution, team lookup, and
 * the delivery fan-out (mailbox + live wake) used by every protocol message.
 *
 * @module dsh-pair-programming/tools/shared
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { deliverToMember } from '../runtime/members.js';
import { scheduleWake } from '../runtime/wake.js';
import { nextObligation, obligationLine } from '../protocol/obligation.js';
import { CAPTAIN_KEY, appendMailbox, acknowledgeMailbox, releaseMailboxDelivery, createMessage } from '../state/mailbox.js';
import { withLock } from '../state/lock.js';
import { stateRootOf, teamLockKey } from '../state/layout.js';
import { findTeamByParticipant, readTeam } from '../state/store.js';
import { appendPairEvent, captainSessionOf } from '../events.js';

/** Require the calling agent (captain or member). */
export function requireAgent(exec) {
  if (!exec.agent) {
    throw new Error('pair_* tools require a calling agent (exec.agent was undefined)');
  }
  return exec.agent;
}

export function workspaceOf(agent) {
  return agent.session.header.cwd ?? process.cwd();
}

export function stateRootFor(agent, config) {
  return stateRootOf(workspaceOf(agent), config);
}

/** Resolve the team the calling agent participates in, or a loud failure. */
export async function requireParticipantTeam(agent, config) {
  const team = await findTeamByParticipant(stateRootFor(agent, config), agent.id);
  if (team === undefined) {
    throw new Error('you do not belong to any pair-programming team — the captain starts one with pair_start');
  }
  return team;
}

/** Whether the caller is the team's captain. */
export function isCaptain(team, agent) {
  return team.captainSessionId === agent.id;
}

/** Resolve the caller's display identity ("captain" or member name). */
export function identityOf(team, agent) {
  if (isCaptain(team, agent)) return CAPTAIN_KEY;
  const member = team.members.find(m => m.id === agent.id && m.status !== 'removed');
  return member?.name ?? agent.id;
}

/**
 * Steer one protocol message to the live captain at its nearest model step.
 * @returns {boolean} whether the captain accepted the steer.
 */
export function steerCaptain(captain, from, content) {
  try {
    captain.steer(createUserMessage({
      content: [{ type: 'text', text: `Pair-programming message from ${from}:\n\n${content}` }],
      source: { kind: 'plugin', plugin: 'dsh-pair-programming' },
    }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Deliver one protocol message to one recipient: persist to the recipient's
 * JSONL mailbox (the durable truth), append a session event, then best-effort
 * live-wake the recipient (member followup / captain steer). Mailboxes are
 * the fallback so no message is lost when the recipient is offline.
 *
 * @returns {Promise<{messageId:string, delivered:'live'|'wake'|'mailbox'}>}
 */
export async function deliverProtocolMessage(ctx, config, caller, team, to, content, exec) {
  const stateRoot = stateRootFor(caller, config);
  const from = identityOf(team, caller);
  // Every protocol message states whose move is next. The board already knows
  // — a cycle's step plus the task's oracle state determine exactly one call —
  // and saying it is what keeps the captain out of the scheduling loop. In the
  // two replayed v3 sessions the captain sent 23 and 151 prose instructions
  // doing this by hand, and where it missed a beat the step simply never
  // happened (0 pair_verify across 35 greens).
  const board = await readTeam(stateRoot, team.id).catch(() => undefined);
  const owed = nextObligation(board ?? team);
  const next = obligationLine(owed, to);
  // The caller learns the same fact from its own tool result. A seat that
  // has just acted is deciding right then whether it may stop, and making
  // it re-derive that from the board is the inference that fails.
  const callerNext = obligationLine(owed, from);
  const message = { ...createMessage(from, to, `${content}

${next}`), deliveryClaimedAt: Date.now() };
  await withLock(teamLockKey(stateRoot, team.id), async () => {
    await appendMailbox(stateRoot, team.id, to, message);
  });
  appendPairEvent(ctx, captainSessionOf(ctx, team.captainSessionId, caller.session), 'pair/message-sent', {
    teamId: team.id, messageId: message.id, from, to, content: message.content, ts: message.ts,
  });

  const captain = ctx.agents.get(team.captainSessionId);
  let delivered = 'mailbox';
  if (to === CAPTAIN_KEY) {
    if (captain !== undefined && !isCaptain(team, caller)) {
      delivered = steerCaptain(captain, from, message.content) ? 'live' : 'mailbox';
    }
  } else if (captain !== undefined) {
    const recipient = team.members.find(m => m.name === to && m.status !== 'removed');
    if (recipient !== undefined && recipient.id !== '') {
      const text = `Pair-programming state policy: inspect ${config.stateDir}/${team.id}/ read-only; never edit team.json or inbox files directly. Use pair_* tools for team state.\n\nMessage from ${from}:\n\n${message.content}`;
      const accepted = await deliverToMember(ctx, captain, recipient.id, text, exec?.signal);
      delivered = accepted ? 'wake' : 'mailbox';
    }
  }

  await withLock(teamLockKey(stateRoot, team.id), () => (delivered === 'mailbox'
    ? releaseMailboxDelivery(stateRoot, team.id, to, [message.id])
    : acknowledgeMailbox(stateRoot, team.id, to, [message.id])));

  // N5 liveness: a mailbox-only delivery to a member has no wake edge of its
  // own — the scheduler selects on `agent/status` idle transitions and an
  // untouched member never transitions. Hand the recovery to the scheduler
  // instead of leaving the message to rot on the board (the O3 stall).
  let woken = false;
  if (delivered === 'mailbox' && to !== CAPTAIN_KEY) {
    woken = scheduleWake(ctx, workspaceOf(caller), team.id, to);
  }

  return { messageId: message.id, delivered, you_owe_next: callerNext, ...(woken ? { recoveryKick: true } : {}) };
}
