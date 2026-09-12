/**
 * Shared helpers for the pair_* tools: caller resolution, team lookup, and
 * the delivery fan-out (mailbox + live wake) used by every protocol message.
 *
 * @module dsh-pair-programming/tools/shared
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { coordinationWorkspace } from '../runtime/workspace-context.js';
import { deliverToMember } from '../runtime/members.js';
import { scheduleWake, wakeRuntimeFor } from '../runtime/wake.js';
import { nextObligation, obligationLine } from '../protocol/obligation.js';
import { specSeatMessage } from '../protocol/exposure.js';
import { CAPTAIN_KEY, appendMailbox, createMessage } from '../state/mailbox.js';
import { prepareMailboxDelivery, finishMailboxDelivery, coalesceWake, deliveryKey,
  urgentMail, observeDeliveryStatus, busyNotificationAllowed, markBusyNotification } from '../runtime/mail-delivery.js';
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
  return coordinationWorkspace(agent.session.header.cwd ?? process.cwd());
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

const CAPTAIN_WAKE_KEYS = new WeakMap();

/**
 * Re-enter the captain on a real board event. Running captains receive a
 * nearest-step steer; idle captains receive a follow-up turn. `key` makes a
 * board revision/obligation edge at-most-once without suppressing later work.
 */
export function wakeCaptain(captain, from, content, key, { envelope = true } = {}) {
  if (captain === undefined) return false;
  let seen;
  if (key !== undefined) {
    seen = CAPTAIN_WAKE_KEYS.get(captain);
    if (seen === undefined) {
      seen = new Set();
      CAPTAIN_WAKE_KEYS.set(captain, seen);
    }
    if (seen.has(key)) return true;
    seen.add(key);
    if (seen.size > 256) seen.delete(seen.values().next().value);
  }
  try {
    const message = createUserMessage({
      content: [{ type: 'text', text: envelope ? `Pair-programming message from ${from}:\n\n${content}` : content }],
      source: { kind: 'plugin', plugin: 'dsh-pair-programming' },
    });
    if (captain.status === 'idle' && typeof captain.followup === 'function') captain.followup(message);
    else if (typeof captain.steer === 'function') captain.steer(message);
    else if (typeof captain.followup === 'function') captain.followup(message);
    else throw new Error('captain exposes neither steer nor followup');
    return true;
  } catch {
    if (key !== undefined) seen?.delete(key);
    return false;
  }
}

/** Backward-compatible name for consumers compiled against 0.3.x. */
export const steerCaptain = wakeCaptain;

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
  // U2, mailbox leg: the acceptance-author seat never receives the candidate in a letter.
  // Today no plugin path addresses that seat with the candidate in it, so the guarantee
  // held only while no such sender existed — one future delivery away from being false.
  // Projecting at the boundary makes it hold by construction, for senders that do not
  // exist yet. Every other seat is untouched, byte for byte.
  const recipientSeat = (team.members ?? []).find(member => member.name === to && member.status !== 'removed');
  const body = recipientSeat?.role === 'spec' ? specSeatMessage(content) : content;
  // Raw facts belong on disk; NEXT is a current-board projection at delivery.
  const message = createMessage(from, to, body);
  await withLock(teamLockKey(stateRoot, team.id), async () => {
    await appendMailbox(stateRoot, team.id, to, message);
  });
  appendPairEvent(ctx, captainSessionOf(ctx, team.captainSessionId, caller.session), 'pair/message-sent', {
    teamId: team.id, messageId: message.id, from, to, content: message.content, ts: message.ts,
  });

  let delivered = 'mailbox';
  let refusal;
  let batch;
  // A captain pause outranks an AMBIENT delivery: a member sending a peer a protocol
  // message must not restart the run the captain stopped. Measured on the defect HEAD:
  // the live wake woke the seat anyway, and declining only that leg changed nothing —
  // the N5 recovery kick at the end of this function hands the same batch to the same
  // seat one tick later. So both legs consult the pause; the durable mailbox write above
  // is untouched and the mail is handed over on the next kick after the pause lifts.
  const captainCaller = isCaptain(team, caller);
  // Only a delivery the CAPTAIN makes is deliberate; a member message to a peer, or to the
  // captain, is ambient and must not restart a paused run.
  const ambient = to !== CAPTAIN_KEY && !captainCaller;
  const pauseHolds = () => ambient && wakeRuntimeFor(ctx)?.isPaused?.(workspaceOf(caller), team.id) === true;
  // The captain speaking is the deliberate action that lifts the pause, and it must do so
  // here: a delivery that left the run paused would leave the sweep off after the captain
  // had already re-engaged, and the ambient gate below would keep suppressing peer mail.
  if (captainCaller) wakeRuntimeFor(ctx)?.trackTeam?.(workspaceOf(caller), team.id);
  const selectedBoard = await readTeam(stateRoot, team.id);
  const selectedId = to === CAPTAIN_KEY ? selectedBoard?.captainSessionId : selectedBoard?.members.find(m => m.name === to && m.status !== 'removed')?.id;
  const key = deliveryKey(stateRoot, team.id, to, selectedId);
  // A wake, not a redundant duplicate: this is the Captain's steer path too,
  // and it had the same dropped-edge shape as the member path (M16'). A steer
  // that arrives while an earlier admission for the same seat is in flight is
  // deferred to the end of that flight instead of vanishing; the re-run
  // re-reads the board, so it can find its own obligation already settled —
  // that is the idempotence the mailbox ACK is there to provide, not a second
  // turn.
  await coalesceWake(ctx, key, async () => {
    const board = await readTeam(stateRoot, team.id);
    if (board === undefined || exec?.signal?.aborted) return;
    if (pauseHolds()) { refusal = 'the captain paused this run — the message waits in the mailbox for a deliberate captain action'; return; }
    const captain = ctx.agents.get(board.captainSessionId);
    if (captain === undefined || (to === CAPTAIN_KEY && isCaptain(board, caller))) return;
    const recipient = to === CAPTAIN_KEY ? captain : board.members.find(m => m.name === to && m.status !== 'removed');
    if (recipient === undefined || recipient.id === '' || recipient.id !== selectedId) return;
    const live = to === CAPTAIN_KEY ? captain : ctx.agents.get(recipient.id);
    const busy = live !== undefined && live.status !== 'idle';
    const turn = observeDeliveryStatus(live);
    if (!busyNotificationAllowed(turn) || (busy && !urgentMail(message))) return;
    batch = await prepareMailboxDelivery(stateRoot, team.id, to, config, { memberId: recipient.id, captainId: captain.id, signal: exec?.signal, urgentOnly: busy });
    if (batch === undefined) return;
    let accepted = false;
    try {
      if (to === CAPTAIN_KEY) accepted = wakeCaptain(captain, from, batch.text, batch.claimId, { envelope: false });
      else {
        const wake = await deliverToMember(ctx, captain, recipient.id, batch.text, exec?.signal);
        accepted = wake.ok;
        if (!accepted) refusal = wake.reason;
      }
    } finally {
      accepted = await finishMailboxDelivery(stateRoot, batch, accepted, exec?.signal);
    }
    if (accepted) {
      if (busy) markBusyNotification(live, turn);
      // This batch can contain earlier controls instead of the sender's mail.
      if (batch.messageIds.includes(message.id)) delivered = to === CAPTAIN_KEY ? 'live' : 'wake';
    }
  });

  // N5 liveness: a mailbox-only delivery to a member has no wake edge of its
  // own — the scheduler selects on `agent/status` idle transitions and an
  // untouched member never transitions. Hand the recovery to the scheduler
  // instead of leaving the message to rot on the board (the O3 stall).
  let woken = false;
  if (delivered === 'mailbox' && to !== CAPTAIN_KEY && !pauseHolds()) {
    // The recovery kick is a wake too, so it consults the same pause as the live wake above.
    woken = scheduleWake(ctx, workspaceOf(caller), team.id, to);
  }

  // The sender learns that its message did not wake anyone, and why. A tool
  // result saying only "delivered: mailbox" reads like success to a model.
  const board = await readTeam(stateRoot, team.id);
  const callerNext = obligationLine(nextObligation(board ?? team, from, { oracleFirst: config.oracleFirst }), from);
  return {
    messageId: message.id, delivered, you_owe_next: callerNext,
    ...(batch === undefined ? {} : { delivery_batch: { selected: batch.count, physicalCount: batch.physicalCount, bytes: batch.bytes, backlog: batch.backlog } }),
    ...(refusal === undefined ? {} : { wake_refused: refusal }),
    ...(woken ? { recoveryKick: true } : {}),
  };
}
