/**
 * Declared blind spots, and the mechanism that makes someone own them.
 *
 * This protocol is unusually good at getting the truth written down. A cycle
 * records what it did beyond the request, what it tuned to make the oracle
 * pass, and how the result deviated from the approved proposal; an oracle
 * records the arms it computes but refuses to gate on. Every one of those is
 * an honest admission that something is NOT covered by the computed verdict.
 *
 * And until now, nothing ever read them again.
 *
 * A captain's own retrospective on a nine-card session put it exactly right:
 * "披露 ≠ 处理" — disclosure happens at GREEN and verify time, and afterwards
 * nobody claims it. That session shipped with rain rendered as white squares,
 * no reflections in the puddles, and a plinth silently stripped of its outline,
 * every one of them written down at the moment it happened, routed to a "visual
 * final check" that had no tool, no checklist and no acceptance file behind it.
 * The board read 9/9 and 56/56 because each of those things WAS disclosed, and
 * a disclosure was worth exactly as much as silence.
 *
 * So a disclosure is now an open item with a ref, and a successful stop is
 * refused while any of them is unclaimed. Closing one is a captain ruling
 * (`pair_arbitrate(closes_disclosure)`), which costs a sentence of rationale
 * and leaves a record — the point is not to forbid shipping with known gaps,
 * it is to make shipping with them a decision somebody made rather than a
 * default nobody noticed.
 *
 * @module dsh-pair-programming/protocol/disclosure
 */

const NONE = new Set(['', 'none', 'n/a', 'na', 'nil', 'nothing', '-', '无', '没有', '无额外']);
const NONE_PREFIXES = [
  'none ', 'none—', 'none-', 'none:', 'nothing ', 'nothing—', 'nothing-', 'nothing:',
  'no deviation', 'no extra change', 'no change beyond', 'no changes beyond', '没有 ', '没有额外', '无额外',
];

/** Whether a declared field actually declares anything. */
export function declares(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return !NONE.has(normalized) && !NONE_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

/**
 * Every blind spot this board has admitted to and not yet adjudicated.
 *
 * @returns {{ref:string, kind:string, subject:string, text:string}[]}
 */
export function openDisclosures(team) {
  const protocol = team?.protocol ?? {};
  const closed = new Set((protocol.decisions ?? [])
    .map(decision => decision.closesDisclosure)
    .filter(ref => typeof ref === 'string' && ref !== ''));
  const items = [];
  const add = (ref, kind, subject, text) => {
    if (!closed.has(ref)) items.push({ ref, kind, subject, text });
  };

  for (const task of team?.tasks ?? []) {
    const arms = task.oracle?.nonGating ?? [];
    if (arms.length > 0) {
      // Include the seal in the ref. If a later re-freeze introduces another
      // blind spot, an old ruling must not silently close the new one merely
      // because it belongs to the same task.
      add(`oracle:${task.id}:${String(task.oracle?.sha ?? 'legacy').slice(0, 12)}:non-gating`, 'non-gating oracle arm', task.id,
        `${arms.join(', ')} — ${task.oracle?.nonGatingReason ?? 'no reason recorded'}`);
    }
  }
  for (const cycle of protocol.cycles ?? []) {
    if (declares(cycle.green?.tunedForOracle)) {
      add(`cycle:${cycle.id}:tuned`, 'tuned to the instrument', cycle.id, cycle.green.tunedForOracle);
    }
    if (declares(cycle.report?.deviations)) {
      add(`cycle:${cycle.id}:deviation`, 'deviation from the approved proposal', cycle.id, cycle.report.deviations);
    }
    if (declares(cycle.verify?.beyondRequest)) {
      add(`cycle:${cycle.id}:beyond`, 'behaviour beyond the request', cycle.id, cycle.verify.beyondRequest);
    }
    if (declares(cycle.noOracleReason)) {
      add(`cycle:${cycle.id}:no-oracle`, 'cycle ran with no frozen oracle', cycle.id, cycle.noOracleReason);
    }
  }
  return items;
}

/** One line per open disclosure, for the board summary. */
export function disclosureSummary(team) {
  const open = openDisclosures(team);
  if (open.length === 0) return 'none open';
  return open.map(item => `${item.ref} (${item.kind}): ${item.text}`).join(' · ');
}

/** The refs a ruling may legally close, so a typo cannot silently close nothing. */
export function knownDisclosureRefs(team) {
  const all = openDisclosures({ ...team, protocol: { ...(team?.protocol ?? {}), decisions: [] } });
  return all.map(item => item.ref);
}
