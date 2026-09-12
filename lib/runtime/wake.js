/**
 * Wake registry (N5): the bridge that lets a protocol delivery ask the
 * scheduler to kick its recipient.
 *
 * Why this exists: `deliverProtocolMessage` writes the durable mailbox and
 * then best-effort live-wakes the recipient. When that live wake does not
 * happen — the captain session is not registered, or `followup` was refused —
 * the message sits in the mailbox and NOTHING wakes the member: the scheduler
 * only selects on an `agent/status` idle EDGE, and a member that never ran
 * produces no edge. That is the O3 stall (GO on the board, Driver idle, cap
 * burned, 0-byte patch).
 *
 * The registry is keyed by the plugin context rather than a module singleton
 * so two compositions in one process cannot cross-wake each other's teams.
 *
 * @module dsh-pair-programming/runtime/wake
 */

/** ctx -> the scheduler runtime installed for it. */
const REGISTRY = new WeakMap();

/** Publish one context's scheduler so tool-side deliveries can reach it. */
export function registerWakeRuntime(ctx, runtime) {
  REGISTRY.set(ctx, runtime);
  return runtime;
}

/** The scheduler runtime for one context, or undefined when none is installed. */
export function wakeRuntimeFor(ctx) {
  return REGISTRY.get(ctx);
}

/**
 * Fire-and-forget kick of one member after a mailbox-only delivery.
 *
 * Deliberately not awaited by the caller: the durable write already happened,
 * the kick is recovery, and a member turn must never be inside the sender's
 * tool call. Failures are logged, never thrown.
 *
 * @returns {boolean} whether a kick was actually scheduled (false = no
 *   scheduler installed, which is the unit-test and library-consumer case).
 */
export function scheduleWake(ctx, workspace, teamId, memberName) {
  const runtime = wakeRuntimeFor(ctx);
  if (runtime?.kickMember === undefined) return false;
  // BACKGROUND compensation, so the flag matters: a captain pause outranks it. #75 fixed exactly
  // this rule for member-triggered kickTeam; without the flag here, any peer's mailbox-only
  // delivery re-tracked the team and the sweep resumed nudging the seat the captain had just
  // stopped, which made "the pause lasts until you speak" false for a message the captain never
  // sent. The idle edge carries the same flag (#75 follow-up: a member's turn ending is automatic
  // too, and it used to clear the pause), and deliverProtocolMessage declines the whole wake leg of
  // an ambient delivery while a run is paused - mailbox only, so the mail is durable.
  void Promise.resolve()
    .then(() => runtime.kickMember(workspace, teamId, memberName, undefined, undefined, { background: true }))
    .catch((error) => {
      ctx.logger?.warn?.(`pair-programming: recovery kick of ${memberName} failed: ${String(error)}`);
    });
  return true;
}
