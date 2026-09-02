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
  const live = [], folded = [];
  for (const m of unread) {
    const dec = decodeMessage(m.content);
    const judge = dec?.body ? ABSORBED_BY[dec.type] : undefined;
    const cyc = judge && dec.body?.cycle_id !== undefined ? team.protocol.cycles.find(c => c.id === dec.body.cycle_id) : undefined;
    if (judge && cyc !== undefined && judge(cyc)) folded.push(`${dec.body.cycle_id} ${dec.type}`);
    else live.push(m);
  }
  if (folded.length === 0) return { collapsed: [], live };
  const byId = new Map();
  for (const e of folded) { const [id, t] = e.split(' '); const ts = byId.get(id); if (ts === undefined) byId.set(id, [t]); else ts.push(t); }
  return { collapsed: [`[${folded.length} absorbed by board: ${[...byId].map(([id, ts]) => `${id} ${ts.join('/')}`).join(', ')}]`], live };
}
