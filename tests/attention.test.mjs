/**
 * V5.1 — the Attention Set and bounded resume after a token-ceiling cut-off.
 *
 * Both mechanisms answer measured failures:
 *
 *   - three readers of one board (pair_status, the digest, the stall report)
 *     each derived "what needs doing" separately, so a captain could be told
 *     one thing and refused at pair_stop for a reason nothing had shown;
 *   - a member turn that ends at the output-token ceiling ends NORMALLY. The
 *     seat goes idle, the board never moved, and the nudge dedupe (keyed on an
 *     unchanged debt) suppressed the only message that would have restarted it.
 */
import {
  attentionSet, attentionLines, truncatedSeats, staleCredentials,
  debtKey, turnEndKind, wasTruncated, MAX_TOKEN_RESUMES, ATTENTION_KINDS,
} from '../lib/protocol/attention.js';
import { initialProtocolState } from '../lib/protocol/machine.js';
import { gateStateFingerprint } from '../lib/protocol/gate.js';

const member = (name, over = {}) => ({ id: `child-${name}`, name, role: name, status: 'idle', joinedAt: 1, ...over });
const task = (over = {}) => ({
  id: 't-1', subject: 's', status: 'in_progress', assignee: 'driver', attemptId: 'a-1',
  dependencies: [], createdAt: 1, updatedAt: 1, ...over,
});

function teamFixture(over = {}) {
  return {
    id: 'at1', name: 'AT', goal: 'g', mode: 'light', tddMode: 'enforce', pairStyle: 'traditional',
    captainSessionId: 'cap1', createdAt: 1, updatedAt: 100,
    members: [member('driver'), member('navigator')],
    tasks: [task()], taskSeq: 1,
    protocol: { ...initialProtocolState(), phase: 'DEVELOPING' },
    evidenceStats: { cacheHits: 0, cacheMiss: 0 },
    ...over,
  };
}

export async function run(check) {
  /* ---- turn-end normalization: two shapes are already on disk ---------- */
  check(turnEndKind({ endReason: 'error' }) === 'error', 'a bare string end reason is read as-is');
  check(turnEndKind({ endReason: { kind: 'max-tokens' } }) === 'max-tokens', 'a structured turn/end reason is read through its kind');
  check(turnEndKind({}) === undefined && turnEndKind(undefined) === undefined, 'a missing end reason is undefined, never a guess');
  check(wasTruncated({ lastTurn: { endReason: { kind: 'max-tokens' } } }), 'a ceiling cut-off is recognised');
  check(!wasTruncated({ lastTurn: { endReason: { kind: 'completed' } } }), 'an ordinary completed turn is not a truncation');

  /* ---- the set is one projection, ordered by urgency ------------------- */
  const plain = teamFixture();
  const set = attentionSet(plain);
  check(set.primary !== undefined, 'a board with a live task has something in its attention set');
  check(set.primary.kind === 'obligation', 'with nothing blocking, the owed protocol call is the primary item');
  check(set.obligation !== undefined && set.primary.obligation === set.obligation, 'the set carries the same obligation object nextObligation returns, not a copy that can drift');

  const risky = teamFixture({
    protocol: {
      ...initialProtocolState(), phase: 'DEVELOPING',
      risks: [{ id: 'r-1', severity: 'P0', status: 'OPEN', scenario: 'data loss', openedAt: 1 }],
    },
  });
  const riskySet = attentionSet(risky);
  check(riskySet.primary.kind === 'blocking-risk', 'an open P0 outranks the cycle in flight');
  check(riskySet.items.some(i => i.kind === 'obligation'), 'the owed call is still listed below it — outranked is not hidden');
  check(ATTENTION_KINDS.indexOf('blocking-risk') < ATTENTION_KINDS.indexOf('obligation'), 'the priority order is declared, not implied by insertion');

  /* ---- disclosures are individual rows, not one summary line ----------- */
  const disclosed = teamFixture({
    tasks: [task({ status: 'completed' })],
    protocol: {
      ...initialProtocolState(), phase: 'DEVELOPING',
      cycles: [{ id: 'c-1', taskId: 't-1', step: 'GREEN', openedAt: 1, green: { tunedForOracle: 'widened the tolerance to pass' } }],
    },
  });
  const disclosedItems = attentionSet(disclosed).items.filter(i => i.kind === 'disclosure');
  check(disclosedItems.length === 1, 'each open disclosure is its own attention row');
  check(disclosedItems[0].who === 'captain' && disclosedItems[0].tool === 'pair_arbitrate', 'a disclosure names the captain and the exact closing call');

  /* ---- stale gate credentials ----------------------------------------- */
  const completed = teamFixture({ tasks: [task({ status: 'completed', gatePassId: 'gp-1' })] });
  const fresh = gateStateFingerprint(completed, 't-1');
  completed.protocol.gatePasses = [{ id: 'gp-1', taskId: 't-1', at: 2, binding: { gateStateSha: fresh, worktreeSha: 'w1' } }];
  check(staleCredentials(completed).length === 0, 'a credential bound to the current board is not stale');
  check(staleCredentials(completed, { worktreeSha: 'w2' })[0]?.why.includes('worktree'), 'a moved worktree invalidates the credential and says which binding broke');
  completed.protocol.gatePasses[0].binding.gateStateSha = 'stale';
  check(staleCredentials(completed)[0]?.why.includes('board'), 'a moved board invalidates the credential');
  const missing = teamFixture({ tasks: [task({ status: 'completed', gatePassId: 'gp-9' })] });
  check(staleCredentials(missing)[0]?.why.includes('no matching gate credential'), 'a completed card with no matching pass is flagged, not skipped');

  /* ---- bounded resume budget ------------------------------------------ */
  const frozen = { sha: 'oracle-sha', chosen: 'c', divergences: [], files: [] };
  const cut = teamFixture({
    tasks: [task({ oracle: frozen })],
    members: [member('driver', { lastTurn: { endReason: { kind: 'max-tokens' }, endedAt: 5 } }), member('navigator')],
  });
  const owed = attentionSet(cut).obligation;
  check(owed?.who === 'driver', 'the fixture owes the Driver a call');
  const key = debtKey(cut, owed);
  check(typeof key === 'string' && key.includes(String(cut.updatedAt)), 'a resume budget is scoped to one owed call on one board revision');

  const firstCut = truncatedSeats(cut);
  check(firstCut.length === 1 && firstCut[0].name === 'driver', 'a truncated seat that still owes the board is surfaced');
  check(firstCut[0].resumes === 0 && firstCut[0].remaining === MAX_TOKEN_RESUMES && !firstCut[0].exhausted, 'an untried seat has its full budget');

  cut.members[0].resume = { debt: key, count: MAX_TOKEN_RESUMES, at: 6 };
  const spent = truncatedSeats(cut);
  check(spent[0].exhausted && spent[0].remaining === 0, 'the budget is spent after MAX_TOKEN_RESUMES continuations of the same debt');
  const spentItem = attentionSet(cut).items.find(i => i.kind === 'truncated-seat');
  check(spentItem.who === 'captain' && spentItem.tool === 'pair_arbitrate', 'an exhausted budget hands the seat to the captain instead of continuing');

  // The whole point of keying on updatedAt: real progress refunds the budget.
  const moved = { ...cut, updatedAt: cut.updatedAt + 1 };
  check(truncatedSeats(moved)[0].resumes === 0, 'a board that actually moved gives the seat a fresh budget');

  // Long truncated prose is not progress: the board revision is what counts.
  check(debtKey(cut, owed) !== debtKey(moved, owed), 'the debt key changes only when the board changes');

  const notOwed = teamFixture({
    tasks: [task({ oracle: frozen })],
    members: [member('driver'), member('navigator', { lastTurn: { endReason: { kind: 'max-tokens' } } })],
  });
  check(truncatedSeats(notOwed).length === 0, 'a seat cut off while owing nothing is verbose, not stuck');

  /* ---- rendering ------------------------------------------------------- */
  const lines = attentionLines(attentionSet(risky));
  check(lines.startsWith('[PAIR:ATTENTION]'), 'the block carries one stable marker consumers can grep');
  check(lines.includes('blocking-risk') && lines.includes('pair_risk_close'), 'each row names the kind and the exact call');
  check(attentionLines({ items: [] }).includes('empty'), 'an empty set says so rather than printing nothing');
  const many = attentionLines({ items: Array.from({ length: 12 }, (_, i) => ({ kind: 'disclosure', who: 'captain', tool: 'pair_arbitrate', ref: `d-${i}`, why: 'w' })) }, { limit: 3 });
  check(many.includes('and 9 more'), 'a long set is capped with an explicit remainder instead of a silent truncation');
}
