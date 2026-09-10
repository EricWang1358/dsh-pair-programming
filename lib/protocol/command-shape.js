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
 * It used to fire on any output containing "No such file or directory".
 * Measured (B7): a frozen acceptance script opened a fixture it could not find,
 * printed `Error: ENOENT: no such file or directory, open 'fixtures/pool.json'`
 * and exited 1 — and the freeze refused it as VERIFICATION_INFRASTRUCTURE,
 * "the program could not start", which is a claim about the shell and was
 * simply false. The words are identical whether the SHELL could not find the
 * program or the PROGRAM could not find a file, so a text mention is only
 * evidence when the sentence names the program: quoted, bare, or as the
 * shell's own `NAME: not found`. An ENOENT anywhere in a script's output
 * proves nothing about whether its interpreter started.
 *
 * Conservative by design: it fires on an explicit not-found exit code, a
 * spawn-level failure, or a shell message that NAMES the program it could not
 * run. A script that happens to print those words about its own input keeps its
 * own exit code, which is a real result about the code.
 *
 * @param {{exit?:number|string, command?:string, outputTail?:string}} run
 * @returns {string|undefined} the reason, or undefined when the run is a real result.
 */
/** Exit codes that mean "found it, could not run it" in a POSIX shell. */
const NOT_FOUND_EXITS = new Set([126, 127, 9009]);

/**
 * The words a shell uses when the NAME it was given is not a runnable program.
 * Locale-dependent, which is why they are never the only evidence.
 */
const NOT_FOUND_OUTPUT = /(?:command not found|not recognized as an internal or external command|CommandNotFoundException|is not recognized as the name of a cmdlet|no such file or directory)/i;

/** What a path-argument comparison should treat as part of a word. */
const WORD_CHAR = /[A-Za-z0-9_.\-\\/]/;

/** Every spelling of the program under test: the token as written, and its basename. */
const programNames = (command) => {
  const first = String(command ?? '').split(/\s+/)[0] ?? '';
  if (first === '') return [];
  return [...new Set([first, first.replace(/^.*[\\/]/, '')])].filter(Boolean).map((name) => name.toLowerCase());
};

/**
 * The shell's own leading prefix is not a mention of the program: `sh: 1: npm:
 * not found` names npm, but `bash: ./run.sh: No such file or directory` names
 * the ARGUMENT, and stripping the prefix is what tells those two apart.
 */
const stripShellPrefix = (line) => line.replace(/^[^\s:]{1,120}:\s*/, '');

/** Whether one sentence names the program, rather than something it touched. */
function namesProgram(line, names) {
  const folded = line.toLowerCase();
  for (const name of names) {
    for (let at = folded.indexOf(name); at >= 0; at = folded.indexOf(name, at + 1)) {
      const before = at === 0 ? '' : folded[at - 1];
      const after = folded[at + name.length] ?? '';
      if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
    }
  }
  return false;
}

/** `NAME: not found` — the name must be adjacent to the phrase, not merely near it. */
function namesProgramNotFound(line, names) {
  const folded = line.toLowerCase();
  for (const name of names) {
    for (let at = folded.indexOf(name); at >= 0; at = folded.indexOf(name, at + 1)) {
      if (at > 0 && WORD_CHAR.test(folded[at - 1])) continue;
      if (/^['"`]?:?\s+not found\b/.test(folded.slice(at + name.length))) return true;
    }
  }
  return false;
}

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
  // The text only counts when the sentence is ABOUT THE PROGRAM. Without that
  // scoping, a script failing to read its own input was misreported as a
  // program that never started, and the freeze refused legitimate acceptance
  // evidence with an infrastructure error about the shell.
  const names = programNames(run.command);
  for (const raw of tail.split('\n')) {
    const line = stripShellPrefix(raw.trim());
    if (line === '') continue;
    if (namesProgram(line, names) && (NOT_FOUND_OUTPUT.test(line) || /`?not found`?\b/i.test(line))) {
      return `the shell reported that "${named}" is not a runnable program, so this run is not a result about the code`;
    }
    if (namesProgramNotFound(line, names)) {
      return `the shell reported that "${named}" is not a runnable program, so this run is not a result about the code`;
    }
  }
  // The messages above are only English. cmd.exe translates them, and on a
  // non-UTF-8 console codepage the translation reaches us as mojibake, so the
  // words cannot be matched in any locale but one — measured on a zh-CN host,
  // where a missing program exits 1 with an unreadable tail and the typo was
  // charged as a product REJECT. The structure survives translation: the shell
  // opens its output by quoting the exact program name it was asked to run.
  if (typeof exit === 'number' && exit !== 0 && tail.trimStart().startsWith(`'${named}'`)) {
    return `the shell opened its output by quoting "${named}" and exited ${exit}, which is how every locale reports a program it could not run, so this run is not a result about the code`;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* "It failed" vs "the measurement failed"                                    */
/* -------------------------------------------------------------------------- */

/**
 * The exit-code mapping a FROZEN EXECUTION CONTRACT may declare, and why it is
 * a declaration rather than a convention.
 *
 * Measured failure (B7). The team's own category rule says `exit 2 = instrument
 * failure, no product verdict` — and every consumer of a run disagreed with it.
 * `pair_integrate` read ANY non-zero exit of an oracle or of the whole-suite
 * command as a product failure, so an acceptance run that could not reach its
 * fixture (exit 2) was reported as `INTEGRATION_ORACLE_FAILED` and charged to
 * the candidate. Meanwhile the same exit was a REJECT in `pair_verify` and a
 * failed gate in `pair_gate_check`. A category rule that lives in prose and is
 * re-derived at each call site is not a rule; it is four opinions.
 *
 * Two things are deliberately NOT done here:
 *
 * - `exit 2` is NOT globally redefined as "environment". On most tools 2 is an
 *   ordinary failure, and a protocol that silently reclassified it would lose
 *   real reds. The default is unchanged and stated: 0 succeeds, anything else
 *   is a verdict about the code.
 * - The declaration is NOT inferred from the output text. An `ENOENT`
 *   somewhere in a script's output proves only that something could not be
 *   read; only the contract that authored the command can say what its exit
 *   codes mean.
 *
 * What remains are five categories that must not be collapsed into each other:
 * success, process-creation failure (the program never started), declared
 * instrument failure (it ran; the measurement is what broke), assertion failure
 * (it ran and it failed), cancellation, and timeout.
 */

/** What to tell whoever has to act on an instrument failure. */
export const INSTRUMENT_RETRY_HINT = 'Nothing was recorded as a verdict, no failure counter was charged, and the work was not judged: repair the measurement (missing prerequisite, fixture, service or environment) and re-run the same command. If that exit code really is a result about the code, remove it from instrument_exit_codes.';

/**
 * Why a declared instrument-exit list cannot be used, or undefined when it can.
 * Refusing `0` is the one hard rule: success is not redefinable, and letting it
 * be declared would turn every green run into "no verdict".
 */
export function instrumentExitCodeProblem(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return 'instrument_exit_codes must be an array of exit codes, for example [2]';
  for (const item of value) {
    const code = typeof item === 'string' && item.trim() !== '' ? Number(item) : item;
    if (!Number.isInteger(code) || code <= 0 || code > 255) {
      return `instrument_exit_codes: ${JSON.stringify(item)} is not an exit code this protocol can declare (an integer 1-255 was expected; 0 is success and is not redefinable)`;
    }
  }
  return undefined;
}

/** Normalize a declared list to distinct integers, in declaration order. */
export function normalizeInstrumentExitCodes(value) {
  if (!Array.isArray(value)) return [];
  const codes = [];
  for (const item of value) {
    const code = typeof item === 'string' && item.trim() !== '' ? Number(item) : item;
    if (!Number.isInteger(code) || code <= 0 || code > 255) continue;
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

/**
 * The "exit code -> meaning" mapping for a frozen oracle (or a proposal's
 * verify plan, or a deployment-level command declaration), exported so
 * `pair_status` can print the contract the team is actually judged by instead
 * of a reader having to reconstruct it from four call sites.
 *
 * @param {object|number[]} [source] - an oracle/proposal record carrying
 *   `instrumentExitCodes`, or the list of codes itself.
 * @returns {Record<string,string>} printable mapping, `default` for the rest.
 */
export function exitSemantics(source) {
  const declared = normalizeInstrumentExitCodes(Array.isArray(source) ? source : source?.instrumentExitCodes);
  const semantics = { 0: 'success' };
  for (const code of declared) semantics[code] = 'instrument failure (no product verdict)';
  semantics.default = 'failure (product verdict)';
  return semantics;
}

const isInstrument = (semantics, exit) => String(semantics?.[exit] ?? '').startsWith('instrument');

/**
 * Classify one completed run, keeping the categories distinct.
 *
 * Order matters and is the whole point: a process-creation failure is decided
 * BEFORE the exit-code map, because a declared code can never make a program
 * that never started into an instrument failure, and a timeout or a
 * cancellation is not a result about anything.
 *
 * @param {{exit?:number|string, command?:string, outputTail?:string}} run
 * @param {Record<string,string>} [semantics]
 * @returns {{kind:string, reason:string}}
 */
export function classifyRun(run, semantics = exitSemantics(undefined)) {
  if (run === undefined) return { kind: 'unknown', reason: 'no run was recorded' };
  const exit = run.exit;
  if (exit === 'cancelled') return { kind: 'cancellation', reason: 'the caller cancelled this evidence run, so it says nothing about the code' };
  if (exit === 'timeout') return { kind: 'timeout', reason: 'the command did not finish inside its time limit, so it says nothing about the code' };
  const unrunnable = notRunnableEvidence(run);
  if (unrunnable !== undefined) return { kind: 'process-creation-failure', reason: unrunnable };
  if (exit === 0) return { kind: 'success', reason: `${String(run.command ?? 'the command')} exited 0` };
  if (isInstrument(semantics, exit)) {
    return {
      kind: 'test-infrastructure-failure',
      reason: `${String(run.command ?? 'the command')} exited ${String(exit)}, which its execution contract declares an instrument failure`,
    };
  }
  return { kind: 'assertion-failure', reason: `${String(run.command ?? 'the command')} exited ${String(exit)}` };
}

/**
 * The refusal for a run whose exit code its own contract declared an instrument
 * failure, or undefined when the run produced a result. Every consumer that
 * executes a declared command funnels through this, so the four call sites can
 * no longer disagree about what the same exit code means.
 */
export function instrumentFailure(run, semantics = exitSemantics(undefined)) {
  const classification = classifyRun(run, semantics);
  if (classification.kind !== 'test-infrastructure-failure') return undefined;
  return `${classification.reason}. No product verdict was recorded. ${INSTRUMENT_RETRY_HINT}`;
}