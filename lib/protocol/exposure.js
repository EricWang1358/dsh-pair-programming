/**
 * Who may see the candidate, and what a seat that may not see it still gets.
 *
 * The SPEC seat derives the acceptance standard from the REQUEST, before any
 * implementation exists — that is the whole argument for the seat (plan I5). It has
 * no reader, no shell and no search, and an allow-list keeps it to four protocol
 * tools. Which is exactly why the board is the surface that still leaks: pair_status
 * is one of those four tools, and it answered with the raw board — every cycle with
 * its proposal files, its RED test files, the Driver's GREEN evidence and its
 * tuned-to-the-instrument declaration, plus every OTHER card's sealed oracle. A seat
 * that reads the candidate's shape before writing the standard has had the standard
 * shaped by the answer, whatever its tool list says.
 *
 * So the projection lives here, pure and testable, and pair_status applies it for the
 * seats that must not see the candidate. The contract stays: a card, its criteria, its
 * own sealed oracle and the goal are all still visible, because those are the facts
 * this seat is supposed to work from.
 *
 * @module dsh-pair-programming/protocol/exposure
 */
import { decodeMessage, encodeMessage } from './messages.js';

/** Which seats may see the candidate. Only the acceptance author may not. */
export function seesCandidate(role) {
  return role !== 'spec';
}

/**
 * The same projection for a MESSAGE BODY. Today no plugin path addresses the acceptance
 * author with the candidate in it, so the mailbox leg of "the SPEC cannot obtain the
 * candidate" holds only by absence of senders — one future delivery to that seat away
 * from being false. Projecting at the boundary makes it hold by construction.
 *
 * Only implementation/evidence fields are dropped. `case_refs`, `readings`,
 * `chosen_reading`, `divergence_candidates` and `evidence` survive: they are the
 * contract and the seat's own reasoning, which this seat is supposed to work from.
 */
const CANDIDATE_BODY_FIELDS = ['diff_summary', 'green_evidence', 'test_results', 'red_evidence', 'red_tail', 'deviations', 'tuned_for_oracle', 'report'];

/** One message body with the candidate removed. */
export function specBodyExposure(body) {
  const view = { ...(body ?? {}) };
  for (const field of CANDIDATE_BODY_FIELDS) delete view[field];
  return view;
}

/**
 * One encoded mailbox text, projected for an acceptance-author seat. A text that is not
 * a protocol message, or that has nothing to remove, is returned BYTE-IDENTICAL so the
 * boundary never rewrites a letter gratuitously.
 */
export function specSeatMessage(content) {
  const decoded = decodeMessage(content);
  if (decoded === undefined || decoded.body === undefined) return content;
  const projected = specBodyExposure(decoded.body);
  if (Object.keys(projected).length === Object.keys(decoded.body).length) return content;
  return encodeMessage(decoded.type, projected);
}

/** Fields a cycle carries that are the candidate or its evidence. */
const CANDIDATE_CYCLE_FIELDS = ['proposal', 'red', 'green', 'report', 'verify', 'review', 'pushbacks', 'corrections', 'noOracleReason'];

/**
 * One cycle with the candidate removed. The step, the stamp and the owner stay: they
 * say where the work stands without saying what it looks like.
 */
export function cycleExposure(cycle) {
  const view = { ...(cycle ?? {}) };
  for (const field of CANDIDATE_CYCLE_FIELDS) delete view[field];
  return view;
}

/**
 * One card with the candidate removed.
 *
 * 'ownTaskId' keeps the full oracle on the card this seat is working on — it needs the
 * digest and the command to re-fork or to check its own seal. Another card's oracle is
 * reduced to the fact that it exists and the first bytes of its digest: knowing the
 * state is useful, reading another task's standard is how a seat derives one from an
 * answer it never saw.
 */
export function taskExposure(task, ownTaskId) {
  const view = { ...(task ?? {}) };
  delete view.output;
  if (task?.oracle !== undefined && task?.id !== ownTaskId) {
    view.oracle = { frozen: true, sha: String(task.oracle.sha ?? '').slice(0, 12) };
  }
  return view;
}

/**
 * Summary lines that describe the candidate rather than the board.
 *
 * The tuned-to-the-instrument declaration is candidate evidence by definition — it is the
 * Driver's own admission that the product was shaped to fit its instrument — and it reaches the
 * summary through more than the line that starts with it: an obligation line quotes the
 * disclosure's free text, and it renders it with the kind in PARENTHESES — "Open disclosures:
 * cycle:c-1:tuned (tuned to the instrument): <the Driver's own words>" — so a rule anchored on the
 * colon form missed it entirely (measured at offset 2572 of the serialised status, #156). Match the
 * phrase, not the punctuation around it.
 * It is only applied to seats that must not see the candidate; everyone else reads every line.
 */
const CANDIDATE_SUMMARY = [/tuned to the instrument/i];

/**
 * The summary a seat sees: identical everywhere the candidate is not described.
 *
 * Filter PER LINE, never per element. An element can be a whole multi-line block — `attentionLines`
 * returns one — and matching the element dropped every row it contained the moment one row quoted
 * candidate text, taking the seat's own obligation and every blocking risk with it (measured: the
 * entire [PAIR:ATTENTION] block vanished for the acceptance seat).
 */
export function summaryFor(role, lines) {
  const nl = String.fromCharCode(10);
  if (seesCandidate(role)) return lines.join(nl);
  return lines
    .filter(line => line !== undefined && line !== null)
    .flatMap(line => String(line).split(nl))
    .filter(line => !CANDIDATE_SUMMARY.some(pattern => pattern.test(line)))
    .join(nl);
}