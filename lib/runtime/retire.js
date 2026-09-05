/** Shared retirement for stop, failed formation and replacement compensation. */
import { recordRetiredMemberIds } from '../state/store.js';
import { interruptMember, markMemberRetired } from './members.js';

export async function retireSpawnedMembers(ctx, captain, stateRoot, members) {
  const spawned = (members ?? []).filter(m => typeof m?.id === 'string' && m.id !== '');
  const ids = spawned.map(m => m.id);
  const failedInterrupts = [];
  // Protect live delivery before waiting for disk; persistence failure cannot
  // keep a retired seat's next-turn queue alive in this process.
  for (const member of spawned) {
    markMemberRetired(ctx, member.id);
    member.status = 'removed'; member.retiredAt = Date.now();
    try { ctx.agents?.get?.(member.id)?.cancel?.({ kind: 'disposed' }); }
    catch (error) { ctx.logger?.warn?.(`pair-programming: clearing retired member ${member.id} failed: ${String(error)}`); }
    if (!interruptMember(ctx, captain, member.id)) failedInterrupts.push(member.id);
  }
  let persisted = true;
  try { await recordRetiredMemberIds(stateRoot, ids); }
  catch (error) {
    persisted = false;
    ctx.logger?.warn?.(`pair-programming: retiring members ${ids.join(', ')} failed: ${String(error)}`);
  }
  return { retired: ids, persisted, failedInterrupts };
}
