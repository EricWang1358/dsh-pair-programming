/**
 * Durable pair-programming session events and their emitter.
 *
 * Adapted from @nanmicoder/dsh-agent-teams `lib/events.js` (MIT) —
 * appendTeamEvent and captainSessionOf. Every protocol mutation appends one
 * event to the captain's Session, so the web client can fold a protocol
 * timeline from the session log. Unknown event types are omitted with a debug
 * log rather than breaking tool execution; disk state stays authoritative.
 *
 * @module dsh-pair-programming/events
 */
import * as dshSession from '@deepseek-ai/dsh-session';

/** Event types already reported as unsupported, to avoid repetitive logs. */
const skippedEventTypes = new Set();

/**
 * Append one pair-programming event to a Session, containing failures (a
 * broken durable record must never break tool execution).
 *
 * Every reach into ctx and session is optional. This is called from the stall
 * escalation path, whose entire purpose is to speak up when the protocol has
 * gone quiet — a logger missing one method there would turn the one mechanism
 * that reports silence into another source of it.
 */
export function appendPairEvent(ctx, session, type, data) {
  const known = dshSession.KNOWN_SESSION_EVENT_TYPES;
  if (known?.has(type) !== true) {
    if (!skippedEventTypes.has(type)) {
      skippedEventTypes.add(type);
      ctx.logger?.debug?.(`pair-programming: session event "${type}" omitted because this harness does not recognize it`);
    }
    return;
  }
  try {
    session?.append?.(type, data);
  } catch (error) {
    ctx.logger?.warn?.(`pair-programming: session record failed after ${type}: ${String(error)}`);
  }
}

/**
 * Resolve the captain's live Session for event recording. The captain agent
 * may be offline (its team outlives the session), in which case the caller's
 * own session is the fallback record target.
 */
export function captainSessionOf(ctx, captainSessionId, fallback) {
  const captain = ctx.agents.get(captainSessionId);
  return captain?.session ?? fallback;
}
