/**
 * Durable pair-programming session events and their emitter.
 *
 * Adapted from @nanmicoder/dsh-agent-teams `lib/events.js` (MIT) —
 * appendTeamEvent and captainSessionOf.
 *
 * READ THIS BEFORE "FIXING" THE GUARD BELOW. On this harness EVERY event this
 * plugin emits is dropped, and that is correct rather than a defect:
 *
 *   - `Session.append()` does not check the type at all; it will happily write
 *     `pair/team-created` into the live log.
 *   - `KNOWN_SESSION_EVENT_TYPES` is a READ-path set, generated from the event
 *     vocabulary the harness itself declares. Its own header states that
 *     downstream plugin events are outside it "by construction".
 *   - `dsh-session-persistence.assertEventsSupported` THROWS
 *     `SessionFormatUnsupportedError` on any persisted event outside that set
 *     that is not marked `ignorable` — refusing to interpret the whole log.
 *   - `ignorable` is the designed escape hatch, and `append()` offers no way to
 *     set it: it writes `{type, seq, time, data, ...surfaceMetadata}` and
 *     nothing else.
 *
 * So appending our own types would not produce a nice protocol timeline. It
 * would write a session log that this build refuses to resume. Dropping the
 * events costs a UI panel nobody has; removing the guard costs the session.
 *
 * The board on disk is the authoritative record, and `pair_status` is the
 * surface. If a future harness admits plugin vocabulary — an `ignorable` flag
 * on `append`, or a registration API — this is the one place to change, and
 * `tests/events.test.mjs` pins the reasoning so the change is deliberate.
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
