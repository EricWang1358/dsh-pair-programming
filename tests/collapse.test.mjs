/** collapseUnread: board-first delivery-time collapse of settled receipts. */
import { collapseUnread } from '../lib/runtime/collapse.js';
import { encodeMessage } from '../lib/protocol/messages.js';
import { fallbackMailboxPrompt } from '../lib/runtime/scheduler.js';

export async function run(check) {
  const T = (cycles) => ({ protocol: { cycles } });
  const M = (type, body) => ({ content: encodeMessage(type, body) });
  const RAW = (content) => ({ content });
  const go = { id: 'c1', step: 'GO', review: { verdict: 'go' } };
  const settled = { id: 'c2', step: 'VERIFIED', red: {}, verify: { verdict: 'accept' } };
  // A: settled GO+RED fold; PROPOSE stays verbatim.
  const a = collapseUnread([M('GO', { cycle_id: 'c1', evidence: 'e' }), M('RED', { cycle_id: 'c2', test_files: ['t'], red_evidence: 'r' }), RAW('[PAIR:PROPOSE]\n{"cycle_id":"c1"}')], T([go, settled]));
  check(a.collapsed.length === 1 && a.collapsed[0] === '[2 absorbed by board: c1 GO, c2 RED]', 'A folds settled receipts into the board line');
  check(a.live.length === 1 && a.live[0].content.startsWith('[PAIR:PROPOSE]'), 'A keeps live PROPOSE verbatim');
  // B: conservative defaults — unknown cycle and undecodable text never fold.
  const junk = RAW('plain chatter, not protocol');
  const b = collapseUnread([M('GO', { cycle_id: 'ghost', evidence: 'e' }), junk], T([go]));
  check(b.collapsed.length === 0 && b.live.length === 2 && b.live[1] === junk, 'B conservative: unknown cycle and non-protocol text stay verbatim');
  // C: stale GREEN receipt folds after a REJECT reset; REJECT itself never folds (D5).
  const rej = M('REJECT', { cycle_id: 'c3', evidence: 'evidence-1', feedback: 'restore the guard and pin it' });
  const c = collapseUnread([M('GREEN', { cycle_id: 'c3', green_evidence: 'g' }), rej], T([{ id: 'c3', step: 'PROPOSED', green: {} }]));
  check(c.collapsed.length === 1 && c.collapsed[0].includes('c3 GREEN'), 'C folds the stale receipt after a reject reset (D5)');
  check(c.live.length === 1 && c.live[0] === rej, 'C keeps REJECT verbatim');
  // D: regression pin — nothing to fold returns the input untouched; empty folds nothing.
  const all = [RAW('[PAIR:PROPOSE]\n{"cycle_id":"c9"}'), junk];
  const d = collapseUnread(all, T([]));
  check(d.collapsed.length === 0 && d.live[0] === all[0] && d.live[1] === junk, 'D all-live input: no summary, identical live array');
  const z = collapseUnread([], T([]));
  check(z.collapsed.length === 0 && z.live.length === 0, 'D empty input folds nothing');
  const fallback = fallbackMailboxPrompt(Array.from({ length: 1000 }, (_, i) => ({ id: `m-${i}`, from: 'nav', content: '界'.repeat(2000) })));
  check(Buffer.byteLength(fallback) <= 16384 && fallback.includes('backlog 992') && fallback.includes('pair_mailbox_read'), 'D the legacy formatter entry point also bounds a 1000-message burst and exposes durable references');
}
