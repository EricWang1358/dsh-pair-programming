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

/* -------------------------------------------------------------------------- */
/* V5.2 — a ruling says what happened to the gap, and where the residual lives. */
/* -------------------------------------------------------------------------- */

/**
 * What a ruling actually did with the declared gap.
 *
 * `fixed` — the gap is gone and the evidence shows it.
 * `accepted` — the gap ships as-is, knowingly.
 * `deferred` — the gap is postponed to named later work.
 *
 * The distinction is not bookkeeping. The measured failure is "accept visual
 * arm as backlog" on a board that had no backlog: the ruling read as settled,
 * the disclosure left the open list, and the residual existed in exactly one
 * place — a sentence in a session transcript that nothing would ever read
 * again. A gap accepted into a backlog must produce a backlog entry.
 */
export const DISPOSITIONS = Object.freeze(['fixed', 'accepted', 'deferred']);

/** Where a residual is durably recorded. Anything here outlives the session. */
export const SINKS = Object.freeze(['board', 'issue', 'document', 'pr']);

/**
 * Why a proposed ruling cannot be recorded, or undefined when it is well formed.
 *
 * @param {{disposition?:string, sink?:string, sinkRef?:string}} input
 */
export function dispositionError(input = {}) {
  const disposition = String(input.disposition ?? '').trim();
  if (disposition === '') {
    return `a ruling that closes a disclosure must say what happened to the gap: disposition=${DISPOSITIONS.join('|')}`;
  }
  if (!DISPOSITIONS.includes(disposition)) {
    return `unknown disposition "${disposition}" (${DISPOSITIONS.join(' | ')})`;
  }
  if (disposition === 'fixed') return undefined;
  const sink = String(input.sink ?? '').trim();
  const sinkRef = String(input.sinkRef ?? '').trim();
  if (sink === '' || sinkRef === '') {
    return `disposition="${disposition}" leaves a residual, so it must name where that residual now lives: sink=${SINKS.join('|')} and a traceable sink_ref. `
      + 'A gap accepted "as backlog" with no backlog entry is the failure this rule exists to stop — the ruling reads as settled and the residual survives only in a transcript.';
  }
  if (!SINKS.includes(sink)) return `unknown sink "${sink}" (${SINKS.join(' | ')})`;
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Billing: which rulings are disputes, and which are the board's own paperwork */
/* -------------------------------------------------------------------------- */

/**
 * What a ruling cost the planning budget.
 *
 * `dispute` — it decided a conflict, so it spends the task's
 * planningMaxArbitrations allowance exactly as before.
 * `bookkeeping` — it discharged a declared blind spot. The board makes that
 * mandatory (a successful stop is refused while any disclosure is unclaimed),
 * so it is an obligation rather than a new dispute, and it is charged to
 * nobody. Measured failure: five refusals of `task "t-1" used 2 of 2 planning
 * arbitrations … spec is not frozen yet`, and the gap only became closable
 * once another Driver opened a cycle and the task left planning — a five-round
 * loop to file the paperwork the protocol itself demanded.
 * `unspecified` — written before this rule existed. Still counted: a record
 * that cannot say what it is must not be assumed free.
 */
export function rulingBilling(decision) {
  if (decision?.billing === 'bookkeeping') return 'bookkeeping';
  if (decision?.billing === 'dispute') return 'dispute';
  return 'unspecified';
}

/** Whether a ruling is the board's own bookkeeping rather than a new dispute. */
export function isBookkeepingRuling(decision) {
  return rulingBilling(decision) === 'bookkeeping';
}

/**
 * The task a disclosure ref is about, or undefined.
 *
 * Refs are minted here: `oracle:<taskId>:<seal>:non-gating` names the card
 * directly, and `cycle:<cycleId>:<kind>` names a cycle whose taskId has to be
 * looked up. Attribution needs this because the ref, not the caller's
 * `conflict_ref`, is what says which task a closing ruling is about.
 */
export function disclosureSubjectTask(team, ref) {
  const parts = String(ref ?? '').split(':');
  if (parts[0] === 'oracle') return parts[1] === undefined || parts[1] === '' ? undefined : parts[1];
  if (parts[0] === 'cycle') return (team?.protocol?.cycles ?? []).find(cycle => cycle.id === parts[1])?.taskId;
  return undefined;
}

/**
 * Every ruling that closed a declared gap, with what it did and where the
 * residual went. Legacy rulings recorded before V5.2 carry no disposition;
 * they are listed as `unspecified` rather than silently reclassified, and they
 * do not block completion — the enforcement point is the tool, and no ruling
 * written from here on can reach this state.
 */
export function residualLedger(team) {
  const out = [];
  for (const decision of team?.protocol?.decisions ?? []) {
    const ref = decision.closesDisclosure;
    if (typeof ref !== 'string' || ref === '') continue;
    out.push({
      ref,
      decisionId: decision.id ?? null,
      disposition: decision.disposition ?? 'unspecified',
      sink: decision.sink ?? null,
      sinkRef: decision.sinkRef ?? null,
      at: decision.at ?? null,
      // Which billing rule the tool applied, so pair_status can state it on the
      // board instead of leaving a captain to infer it from the tool source.
      billing: rulingBilling(decision),
      chargedTo: decision.chargedTo ?? null,
    });
  }
  return out;
}

/** Residuals that exist but have no durable home — legacy records only. */
export function unsunkResiduals(team) {
  return residualLedger(team).filter(row => row.disposition !== 'fixed'
    && (typeof row.sinkRef !== 'string' || row.sinkRef.trim() === ''));
}

/** One line per residual, for the board summary and the completion receipt. */
export function residualSummary(team) {
  const rows = residualLedger(team);
  if (rows.length === 0) return 'none recorded';
  return rows.map(row => `${row.ref} -> ${row.disposition}${row.sinkRef ? ` @ ${row.sink}:${row.sinkRef}` : ''}${billingNote(row)}`).join(' · ');
}

/** The billing rule, in the words pair_status shows. */
function billingNote(row) {
  if (row.billing === 'bookkeeping') return ' [bookkeeping: closing a declared gap, no planning arbitration charged]';
  if (row.billing === 'dispute') return ` [new dispute${row.chargedTo ? `, charged to ${row.chargedTo}` : ''}]`;
  return '';
}

/** The refs a ruling may legally close, so a typo cannot silently close nothing. */
export function knownDisclosureRefs(team) {
  const all = openDisclosures({ ...team, protocol: { ...(team?.protocol ?? {}), decisions: [] } });
  return all.map(item => item.ref);
}
