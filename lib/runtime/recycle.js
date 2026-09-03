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
import { withLock } from '../state/lock.js';
import { teamLockKey } from '../state/layout.js';
import { readTeam, writeTeam, recordRetiredMemberIds } from '../state/store.js';
import { boardDigest } from '../protocol/digest.js';
import { personaFor, memberWelcome } from '../protocol/personas.js';
import { resolveMemberLlmSelection, spawnMember, interruptMember } from './members.js';

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
  if (config.memberLifetime !== 'cycle') return { recycled: false, reason: 'memberLifetime != cycle' };
  const team = await readTeam(stateRoot, teamId);
  if (team === undefined) return { recycled: false, reason: 'team no longer exists' };
  if (team.protocol?.phase === 'DONE' || team.protocol?.phase === 'RETRO') return { recycled: false, reason: 'team is wrapping up' };
  const member = team.members.find(m => m.name === memberName && m.status !== 'removed');
  if (!memberIsStale(team, member)) return { recycled: false, reason: 'seat is still current' };
  const captain = ctx.agents?.get?.(team.captainSessionId);
  if (captain === undefined) return { recycled: false, reason: 'captain session is not live' };

  const replacement = {
    ...member,
    id: '',
    joinedAt: Date.now(),
    welcome: [
      memberWelcome(team, member.role),
      boardDigest(team, { memberName: member.name, role: member.role }),
      'Your seat was recycled at the end of the last accepted cycle: you carry no transcript, only this digest. The board is the team memory — continue the protocol from the step it names, and read the repository for anything else you need.',
    ].join('\n\n'),
  };
  try {
    const selection = await resolveMemberLlmSelection(ctx, captain, {}, opts.signal);
    await spawnMember(ctx, config, runtime.selections, selection, captain, team, replacement, personaFor(member.role)(team, replacement, config.stateDir), opts.signal);
  } catch (error) {
    ctx.logger?.warn?.(`pair-programming: recycling ${memberName} failed, keeping the live seat: ${String(error)}`);
    return { recycled: false, reason: 'spawn refused' };
  }

  const oldId = member.id;
  await withLock(teamLockKey(stateRoot, teamId), async () => {
    const fresh = await readTeam(stateRoot, teamId);
    const target = fresh?.members.find(m => m.name === memberName && m.status !== 'removed');
    if (fresh === undefined || target === undefined) return;
    target.id = replacement.id;
    target.status = 'idle';
    target.joinedAt = replacement.joinedAt;
    await writeTeam(stateRoot, fresh);
  });

  // Only once the board points at the new seat does the old one stop.
  try {
    await recordRetiredMemberIds(stateRoot, [oldId]);
  } catch (error) {
    ctx.logger?.warn?.(`pair-programming: recording retired id ${oldId} failed: ${String(error)}`);
  }
  interruptMember(ctx, captain, oldId);
  return { recycled: true, oldId, newId: replacement.id };
}
