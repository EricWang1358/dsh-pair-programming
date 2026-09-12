/**
 * Per-cycle member recycling (R2): dissolve a seat once the cycle it was
 * spawned for has been accepted, and respawn it from the board digest instead
 * of carrying a transcript into the next cycle.
 *
 * Two ordering rules make this safe:
 *
 * 1. Spawn, then retire. A failed spawn must leave the team exactly as it was,
 *    with its live member still reachable. Recycling is best-effort by
 *    construction: if anything refuses, the session keeps its durable seat and
 *    pays v2 prices — a cost regression, never a correctness one.
 * 2. Recycle on the member's own idle edge, never from inside a tool call. The
 *    Navigator that accepts a cycle is itself a candidate; interrupting it
 *    from within its own turn would cancel the turn that is still returning.
 *
 * @module dsh-pair-programming/runtime/recycle
 */
import { readTeam, writeTeam, commitMemberReplacement } from '../state/store.js';
import { retireSpawnedMembers } from './retire.js';
import { isDispatchClosed } from '../protocol/machine.js';
import { seesCandidate } from '../protocol/exposure.js';
import { boardDigest } from '../protocol/digest.js';
import { personaFor, memberWelcome } from '../protocol/personas.js';
import { cePushAppendix } from '../integrations/ce-push.js';
import { workspaceOf } from '../tools/shared.js';
import { resolveMemberLlmSelection, seatModelRequest, isQuotaError, setNavRouteFallback, spawnMember } from './members.js';

/**
 * Whether one member's seat has outlived the cycle it was spawned for: some
 * cycle has been accepted since it joined. Pure — unit-testable.
 */
export function memberIsStale(team, member) {
  if (member === undefined || member.status === 'removed' || member.id === '') return false;
  const joined = member.joinedAt ?? 0;
  return (team.protocol?.cycles ?? []).some(c => c.verify?.verdict === 'accept' && (c.verify.at ?? 0) > joined);
}

/**
 * Recycle one member: spawn a replacement seeded with the board digest, point
 * the board at it, then retire the old session.
 *
 * @returns {Promise<{recycled:boolean, reason?:string}>}
 */
export async function recycleMember(ctx, config, runtime, stateRoot, teamId, memberName, opts = {}) {
  if (!opts.force && config.memberLifetime !== 'cycle') return { recycled: false, reason: 'memberLifetime != cycle' };
  const team = await readTeam(stateRoot, teamId);
  if (team === undefined) return { recycled: false, reason: 'team no longer exists' };
  if (team.parallel && !opts.force) return { recycled: false, reason: 'parallel seats retain their candidate ownership' };
  if (isDispatchClosed(team.protocol?.phase)) return { recycled: false, reason: 'team is wrapping up' };
  const member = team.members.find(m => m.name === memberName && m.status !== 'removed');
  if (member === undefined || member.id === '') return { recycled: false, reason: 'seat no longer exists' };
  if (typeof runtime.releaseTeamSeats !== 'function') throw new Error('recycling requires scheduler.releaseTeamSeats');
  // force: a quota death has already ended the seat mid-cycle — staleness is
  // moot, and the respawn IS the recovery (M20), not an optimization.
  if (!opts.force && !memberIsStale(team, member)) return { recycled: false, reason: 'seat is still current' };
  const captain = ctx.agents?.get?.(team.captainSessionId);
  if (captain === undefined) return { recycled: false, reason: 'captain session is not live' };

  const replacement = {
    ...member,
    id: '',
    joinedAt: Date.now(),
    replacementReason: opts.force ? 'recovery' : 'accepted-cycle',
    welcome: [
      memberWelcome(team, member.role),
      // The replacement reads the same projection as the seat it replaces: an acceptance seat must not
      // receive the candidate through its welcome digest (#155; the plan's item 7).
      boardDigest(team, { memberName: member.name, role: member.role, candidateVisible: seesCandidate(member.role) }),
      'Your seat was replaced; the current cycle may still be unfinished. You carry no transcript, only this digest. The board is the team memory — continue the protocol from the step it names, and read the repository for anything else you need.',
    ].join('\n\n'),
  };
  try {
    let selection = await resolveMemberLlmSelection(ctx, captain, seatModelRequest(config, member.role, team), opts.signal);
    delete replacement.reasoningEffort;
    Object.assign(replacement, selection);
    // V5.3d: the one phase-bound push. A respawn is the only moment a persona
    // can be composed, and REFACTOR is the only step where this body is worth
    // its place in a prefix the seat re-sends for its whole life.
    const persona = personaFor(member.role)(team, replacement, config.stateDir)
      + (runtime.ce === undefined ? '' : await cePushAppendix({
        lane: runtime.ce.lane(), role: member.role, team,
        probe: runtime.ce.probe(), cache: runtime.ce.cache,
        // The seat's own workspace, so the ledger attributes the pushed load
        // to the board it was pushed into.
        load: (name) => runtime.ce.load(name, { cwd: workspaceOf(captain) }),
      }).catch(() => ''));
    await spawnMember(ctx, config, runtime.selections, selection, captain, team, replacement, persona, opts.signal);
  } catch (error) {
    // Quota fallback (M20): the premium route died of exhaustion on respawn —
    // retry once on the captain's route rather than leaving the seat dead.
    const request = seatModelRequest(config, member.role, team);
    if (request.model !== undefined && isQuotaError(String(error))) {
      setNavRouteFallback('模型 ' + request.provider + '/' + request.model + ' 用量耗尽（'
        + String(error?.message ?? error).slice(0, 160) + '）——' + member.role + ' 席位已回退为队长模型与配置', team);
      try {
        const fallbackSelection = await resolveMemberLlmSelection(ctx, captain, {}, opts.signal);
        replacement.provider = fallbackSelection.provider;
        replacement.model = fallbackSelection.model;
        replacement.reasoningEffort = fallbackSelection.reasoningEffort;
        const persona2 = personaFor(member.role)(team, replacement, config.stateDir);
        await spawnMember(ctx, config, runtime.selections, fallbackSelection, captain, team, replacement, persona2, opts.signal);
      } catch (fallbackError) {
        ctx.logger?.warn?.('pair-programming: recycling ' + memberName + ' failed, keeping the live seat: ' + String(fallbackError));
        return { recycled: false, reason: 'spawn refused' };
      }
    } else {
      ctx.logger?.warn?.('pair-programming: recycling ' + memberName + ' failed, keeping the live seat: ' + String(error));
      return { recycled: false, reason: 'spawn refused' };
    }
  }

  const oldId = member.id;
  let committed = false, failure;
  try {
    if (!opts.signal?.aborted) committed = await commitMemberReplacement(stateRoot, teamId, member, replacement, team.parallel ? async (root, fresh) => {
      // Explicit recovery transfers unfinished debt atomically with the seat.
      // Accepted evidence remains immutable; a new actor can complete/gate it
      // but cannot rewrite the signed cycle. The task attempt stays unchanged.
      for (const cycle of fresh.protocol.cycles) {
        const task = fresh.tasks.find(item => item.id === cycle.taskId);
        if (cycle.owner?.memberId === member.id && cycle.owner?.attemptId === task?.attemptId
          && task?.assignee === replacement.name && !['accept', 'checkpoint'].includes(cycle.verify?.verdict) && cycle.step !== 'CLOSED') {
          cycle.owner = { ...cycle.owner, memberId: replacement.id };
        }
      }
      await writeTeam(root, fresh);
    } : undefined);
  } catch (error) {
    failure = String(error);
    ctx.logger?.warn?.(`pair-programming: replacement commit for ${teamId}/${memberName} failed: ${failure}`);
  }
  const retired = committed ? member : replacement;
  const cleanup = await retireSpawnedMembers(ctx, captain, stateRoot, [retired]);
  runtime.releaseTeamSeats([retired.id]);
  return committed
    ? { recycled: true, oldId, newId: replacement.id, cleanup }
    : { recycled: false, reason: failure ?? 'seat changed before replacement committed', cleanup };
}
