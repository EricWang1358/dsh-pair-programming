/**
 * The `[PAIR:*]` protocol message DSL: encode, decode, and validate.
 *
 * Every protocol message is plain mailbox content whose text starts with a
 * `[PAIR:<TYPE>]` header followed by a JSON body. The DSL is the protocol's
 * parseable backbone: tools, the UI timeline, and the log all key off the
 * header. Decoding is lenient — a member that free-forms its reply is not
 * dropped; the text is surfaced for re-statement instead.
 *
 * Pure logic, no cordis / I/O imports — unit-testable.
 *
 * @module dsh-pair-programming/protocol/messages
 */

/** All protocol message types. */
export const MESSAGE_TYPES = Object.freeze([
  'ORACLE',      // Navigator → Driver+Captain (SPEC-FORK: the frozen acceptance oracle, N1)
  'PROPOSE',     // Driver → Navigator
  'GO',          // Navigator → Driver
  'NO_GO',       // Navigator → Driver (constructive feedback: observation/impact/way_forward)
  'RED',         // Driver → Navigator (failing test landed — TDD step 1)
  'GREEN',       // Driver → Navigator (minimal code passes the test — TDD step 2)
  'REFACTOR',    // Driver → Navigator (cleanup under green + final report — TDD step 3)
  'ATTACK',      // Challenger → Driver+Navigator
  'REPORT',      // Driver → Navigator (non-TDD path: implementation report)
  'ACCEPT',      // Navigator → Driver
  'REJECT',      // Navigator → Driver (constructive feedback required)
  'RAISE',       // Challenger → Captain (cc Navigator)
  'CLEAR',       // Challenger → Captain
  'ARBITRATE',   // Captain → all
  'GATE_PASS',   // tool (auto) → Captain
  'GATE_FAIL',   // tool (auto) → Captain
  'HANDOFF',     // Captain → new Driver (rotate)
  'INFO',        // any → any (free-form protocol notice)
]);

const HEADER = /^\[PAIR:([A-Z_]+)\][ \t]*\n?/;

/**
 * Encode one protocol message to mailbox text.
 * @param {string} type - one of MESSAGE_TYPES.
 * @param {object} body - the JSON-serializable payload.
 * @returns {string} the mailbox text.
 */
export function encodeMessage(type, body) {
  if (!MESSAGE_TYPES.includes(type)) {
    throw new Error(`unknown pair message type "${type}"`);
  }
  return `[PAIR:${type}]\n${JSON.stringify(body, null, 2)}`;
}

/**
 * Decode one mailbox text into { type, body } or undefined when the text is
 * not a protocol message. Lenient: a valid header with an unparseable body
 * still returns the type with a `rawBody` fallback so the caller can surface
 * the text for re-statement instead of dropping the turn.
 *
 * @param {string} text - the mailbox content.
 * @returns {{type:string, body:object}|{type:string, rawBody:string}|undefined}
 */
export function decodeMessage(text) {
  if (typeof text !== 'string') return undefined;
  const match = HEADER.exec(text.trimStart());
  if (match === null) return undefined;
  const type = match[1];
  if (!MESSAGE_TYPES.includes(type)) return undefined;
  const rest = text.trimStart().slice(match[0].length).trim();
  if (rest === '') return { type, body: {} };
  try {
    return { type, body: JSON.parse(rest) };
  } catch {
    return { type, rawBody: rest };
  }
}

/** Whether one mailbox text carries a protocol header at all. */
export function isProtocolMessage(text) {
  return typeof text === 'string' && HEADER.test(text.trimStart());
}

/* ------------------------------------------------------------------------- */
/* Field validation (soft: returns a list of missing fields, never throws)    */
/* ------------------------------------------------------------------------- */

const REQUIRED = {
  PROPOSE: ['cycle_id', 'intent', 'files', 'verify_plan'],
  GO: ['cycle_id', 'evidence'],
  NO_GO: ['cycle_id', 'feedback'],
  RED: ['cycle_id', 'test_files', 'red_evidence'],
  GREEN: ['cycle_id', 'green_evidence'],
  REFACTOR: ['cycle_id', 'diff_summary', 'test_results'],
  ATTACK: ['risk_id', 'severity', 'scenario', 'trigger', 'suggestion'],
  REPORT: ['cycle_id', 'diff_summary', 'test_results'],
  ACCEPT: ['cycle_id', 'evidence'],
  REJECT: ['cycle_id', 'evidence', 'feedback'],
  RAISE: ['risk_id'],
  CLEAR: ['risk_id'],
  ARBITRATE: ['conflict_ref', 'decision', 'evidence', 'rationale'],
  GATE_PASS: ['cycle_id'],
  GATE_FAIL: ['cycle_id', 'failures'],
  HANDOFF: ['progress', 'open_risks', 'next_steps', 'pitfalls'],
  INFO: [],
};

/**
 * Validate the constructive-feedback triad (observation -> impact ->
 * way forward). Returns the list of problems; empty when the feedback is
 * well formed. This turns the course's "actionable, never vague" rule into a
 * machine-checked message shape: all three parts must be present, non-empty,
 * and free of empty hedges like "make it better".
 *
 * @param {object|undefined} feedback - { observation, impact, way_forward }.
 * @returns {string[]} problems (empty when valid).
 */
export function feedbackProblems(feedback) {
  if (!isRecord(feedback)) return ['feedback must be an object {observation, impact, way_forward}'];
  const problems = [];
  for (const part of ['observation', 'impact', 'way_forward']) {
    const value = feedback[part];
    if (typeof value !== 'string' || value.trim().length < 8) {
      problems.push(`feedback.${part} must be a concrete statement (>= 8 chars)`);
    }
  }
  const hedge = /^(make it better|improve it|looks off|could be better|不太行|再改改)\W*$/i;
  if (typeof feedback.way_forward === 'string' && hedge.test(feedback.way_forward.trim())) {
    problems.push('feedback.way_forward must be an actionable change, not a vague wish');
  }
  return problems;
}

/**
 * List the required fields missing from one decoded body.
 * @param {string} type
 * @param {object} body
 * @returns {string[]} missing field names (empty when complete).
 */
export function missingFields(type, body) {
  const required = REQUIRED[type] ?? [];
  if (!isRecord(body)) return [...required];
  return required.filter((field) => body[field] === undefined);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
