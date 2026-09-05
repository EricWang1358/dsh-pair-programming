/**
 * Is this string something a shell could run?
 *
 * The measured failure. `pair_propose.verify_plan` was documented as "How the
 * change will be verified (test/build/lint command)" — a leading clause that
 * invites prose and a parenthetical that asks for a command. Nothing checked
 * which one arrived. Two steps later `pair_verify(stage="checkpoint")` passed
 * that string to the shell, and a Driver who had written
 *
 *   1) npm test must stay fully green  2) Live adapter smoke: node --input …
 *
 * got a non-zero exit, which the tool converted into `verdict: 'reject',
 * category: 'checkpoint_red'` — "the cycle's predeclared verify_plan still
 * fails". The work was fine. The declaration was prose.
 *
 * Why that is worse than an inconvenience. This protocol's entire claim is
 * that a verdict is a re-run rather than an assertion: `computeVerdict` exists
 * so nobody can say "it passes". A false REJECT breaks that claim from the
 * other side — it manufactures a machine verdict out of a declaration defect,
 * charges `stats.reject` and the cycle's `rejections` budget for a failure
 * that never happened, rewinds the cycle out of its GO, and hands the Driver
 * structured feedback about code that was never the problem. A verdict that
 * can be wrong for reasons unrelated to the product is not evidence.
 *
 * So the shape is checked at DECLARATION time, where the mistake is, and
 * re-checked before execution, where a malformed string must raise a tool
 * error rather than become a verdict.
 *
 * Deliberately permissive: this rejects prose, not unusual commands. Anything
 * that could plausibly be a command line passes, because refusing a valid
 * command would block real work, while accepting a prose plan only defers the
 * error to the shell — which is exactly the bug.
 *
 * Pure logic, unit-testable.
 *
 * @module dsh-pair-programming/protocol/command-shape
 */

/** Numbered/bulleted list markers a plan uses and a command never starts with. */
const LIST_MARKER = /^\s*(?:[-*•]|\(?\d{1,2}[.)])\s+/;

/** Sentence punctuation that no shell token carries in its first word. */
const PROSE_TAIL = /[。，；：！？]|(?:[.!?]\s)|(?:[,;]\s)/;

/** Modal prose that reads as a requirement rather than an invocation. */
const REQUIREMENT_WORDS = /\b(?:must|should|shall|need(?:s)? to|ought to|ensure|verify that|make sure)\b/i;

/**
 * Why this string cannot be executed as a command, or undefined when it can.
 *
 * @param {string} value - the declared verify plan.
 * @param {{ field?: string }} [opts] - the field name to name in the refusal.
 * @returns {string|undefined}
 */
export function commandShapeError(value, opts = {}) {
  const field = opts.field ?? 'verify_plan';
  const raw = String(value ?? '');
  const text = raw.trim();
  const advice = `${field} is EXECUTED verbatim by pair_verify(stage="checkpoint") — it must be one runnable command line (for example "npm test" or "node tests/run.mjs"), not a description of how verification will go. Put the reasoning in intent; put the command here.`;

  if (text === '') return `${field} is empty. ${advice}`;

  // A plan, not a command. This is the exact shape that produced the measured
  // false REJECT, so it is named first and explicitly.
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length > 1) {
    return `${field} spans ${lines.length} lines, so it is a plan rather than a command. ${advice} `
      + 'If verification genuinely needs several commands, chain them into one line (&&) or put them behind one script.';
  }
  if (LIST_MARKER.test(raw)) {
    return `${field} starts with a list marker, so it is a plan rather than a command. ${advice}`;
  }
  if (REQUIREMENT_WORDS.test(text)) {
    return `${field} reads as a requirement ("must", "should", "ensure" …) rather than an invocation. ${advice}`;
  }
  if (PROSE_TAIL.test(text)) {
    return `${field} carries sentence punctuation, so it reads as prose rather than a command. ${advice}`;
  }
  // A command's first token is a program name or a path: no spaces, and not a
  // bare word ending in sentence punctuation (already excluded above).
  const first = text.split(/\s+/)[0];
  if (first.length === 0) return `${field} has no leading program name. ${advice}`;
  return undefined;
}

/** Convenience predicate. */
export function isRunnableCommand(value) {
  return commandShapeError(value) === undefined;
}

/* -------------------------------------------------------------------------- */
/* Did it fail, or did it never run?                                          */
/* -------------------------------------------------------------------------- */

/** Exit codes a shell uses for "I could not find that program". */
const NOT_FOUND_EXITS = new Set([127, 9009]);

/** What a shell prints when the program name is not a program. */
const NOT_FOUND_OUTPUT = /(?:command not found|not recognized as an internal or external command|No such file or directory|CommandNotFoundException|is not recognized as the name of a cmdlet)/i;

/**
 * Whether a completed run shows the command never executed at all.
 *
 * Why this is separate from the shape check, and why it matters most at the
 * oracle freeze. `redProblem` requires the oracle command to FAIL today —
 * that is what makes it a RED. So the freeze gate actively REWARDS a command
 * that cannot run: a typo (`npn test`) fails, passes the RED check, seals into
 * the task contract, and then fails identically at every later verdict. The
 * board reads "the implementation still does not satisfy acceptance" forever,
 * and the true cause — three characters in a command line — is invisible
 * because failing is exactly what the oracle was supposed to do.
 *
 * A shape check cannot catch this: `npn test` is a perfectly well-formed
 * command line. Only the run can tell, and only by looking at HOW it failed.
 *
 * Conservative by design: it fires on an explicit not-found exit code, a
 * spawn-level failure, or a shell's own not-found message. A test suite that
 * happens to print "command not found" in its own output still exits with its
 * own code, so the exit check leads and the text check only covers shells that
 * report not-found through exit 1.
 *
 * @param {{exit?:number|string, command?:string, outputTail?:string}} run
 * @returns {string|undefined} the reason, or undefined when the run is a real result.
 */
export function notRunnableEvidence(run) {
  if (run === undefined) return undefined;
  const exit = run.exit;
  const tail = String(run.outputTail ?? '');
  const named = String(run.command ?? '').split(/\s+/)[0] || 'the command';
  if (exit === 'error') {
    return `the shell could not start "${named}" at all (spawn failure), so this run is not a result about the code`;
  }
  if (typeof exit === 'number' && NOT_FOUND_EXITS.has(exit)) {
    return `the shell could not find "${named}" (exit ${exit}), so this run is not a result about the code`;
  }
  if (NOT_FOUND_OUTPUT.test(tail)) {
    return `the shell reported that "${named}" is not a runnable program, so this run is not a result about the code`;
  }
  return undefined;
}
