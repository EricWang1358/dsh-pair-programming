/** Delivery-time collapse: fold offline receipts whose effect is already on the board (D1-D4). */
import { decodeMessage } from '../protocol/messages.js';

/** Receipt type -> the board effect that proves absorption; every other message stays verbatim. */
const ABSORBED_BY = {
  GO: (c) => c.review?.verdict === 'go',
  RED: (c) => c.red !== undefined,
  GREEN: (c) => c.green !== undefined,
  REFACTOR: (c) => c.report !== undefined,
  ACCEPT: (c) => c.verify?.verdict === 'accept',
};

export function collapseUnread(unread, team) {
  const live = [], absorbed = [], counts = new Map();
  const cycles = new Map((team.protocol?.cycles ?? []).map(cycle => [cycle.id, cycle]));
  for (const m of unread) {
    const dec = decodeMessage(m.content);
    const judge = dec?.body && !['P0', 'P1'].includes(dec.body.severity) ? ABSORBED_BY[dec.type] : undefined;
    const cyc = judge && dec.body?.cycle_id !== undefined ? cycles.get(dec.body.cycle_id) : undefined;
    if (judge && cyc !== undefined && judge(cyc)) {
      absorbed.push(m);
      counts.set(dec.type, (counts.get(dec.type) ?? 0) + 1);
    }
    else live.push(m);
  }
  // Five known receipt types bound the summary independently of backlog or
  // cycle-id lengths. Physical records stay available for conditional ACK.
  const collapsed = absorbed.length === 0 ? [] : [`[${absorbed.length} absorbed by board: ${[...counts].map(([type, count]) => `${type} ${count}`).join(', ')}. Read pair_status for current tasks/cycles; original receipts remain in the durable mailbox.]`];
  return { collapsed, live, absorbed };
}
