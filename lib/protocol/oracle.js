/**
 * The acceptance oracle (N1): the one piece of information the implementer
 * does not already have.
 *
 * Why it exists. In v2 every verification closed over the premise the code was
 * written from: the Navigator reviewed against acceptance criteria the team
 * had authored from its own reading of the request, and the RED test was
 * written by the Driver under that same reading. Independent *agents* with a
 * shared *oracle* produce correlated errors — measured across eight rounds as
 * bit-identical failures between a pair team and a lone agent.
 *
 * The oracle inverts that. The Navigator derives an acceptance test from the
 * REQUEST ALONE, before any approach exists, enumerates the readings the
 * request permits, names how a hidden acceptance test could disagree with the
 * chosen one, and freezes the result under a digest. From then on the verdict
 * is a re-run, not an opinion, and a Driver that edits the oracle is caught by
 * the digest rather than by discipline.
 *
 * Pure logic — no fs, no exec (one pure sibling import). The filesystem and
 * command halves live in tools/oracle-exec.js.
 *
 * @module dsh-pair-programming/protocol/oracle
 */
import { notRunnableEvidence } from './command-shape.js';

/** Minimum distinct readings the request must be forked into. */
export const MIN_READINGS = 2;
/** Minimum divergence candidates (what replaces the Challenger seat). */
export const MIN_DIVERGENCES = 1;

const text = (v) => String(v ?? '').trim();
const list = (v) => (Array.isArray(v) ? v.map(text).filter(Boolean) : []);

/**
 * Validate one SPEC-FORK submission. Returns the list of problems; empty means
 * the fork may be frozen.
 *
 * The checks are deliberately about *shape of thought*, not prose quality: at
 * least two genuinely different readings, a chosen one that is among them, at
 * least one way the hidden acceptance could disagree, and an executable
 * command that fails today.
 */
export function forkProblems(input = {}) {
  const problems = [];
  const readings = list(input.readings);
  const unique = new Set(readings.map(r => r.toLowerCase()));
  if (readings.length < MIN_READINGS) {
    problems.push(`readings: give at least ${MIN_READINGS} distinct interpretations of the request (got ${readings.length}) — the fork is the point, a single reading is the v2 failure`);
  } else if (unique.size < readings.length) {
    problems.push('readings: two readings are the same text — a restatement is not a second interpretation');
  }
  const chosen = text(input.chosen_reading);
  if (chosen === '') {
    problems.push('chosen_reading: name the reading this oracle encodes');
  } else if (readings.length > 0 && !readings.some(r => r.toLowerCase() === chosen.toLowerCase())) {
    problems.push('chosen_reading: must be one of the readings you listed verbatim');
  }
  if (list(input.divergence_candidates).length < MIN_DIVERGENCES) {
    problems.push(`divergence_candidates: name at least ${MIN_DIVERGENCES} way a hidden acceptance test could disagree with the chosen reading (this is the adversarial duty the Challenger seat used to carry)`);
  }
  if (list(input.oracle_files).length === 0) {
    problems.push('oracle_files: the acceptance test must exist as files so it can be frozen under a digest');
  }
  if (text(input.oracle_cmd) === '') {
    problems.push('oracle_cmd: give the command that runs the acceptance test');
  }
  return problems;
}

/**
 * Whether an oracle run counts as the RED that opens the cycle.
 * An oracle that passes before any implementation is not an oracle — it is a
 * tautology, and it is exactly how i2/O2 shipped green while broken.
 */
export function redProblem(run) {
  if (run?.exit === 0) {
    return 'the oracle PASSES on the untouched tree — it asserts behaviour that already exists, so it cannot detect the change being asked for. Rewrite it to fail for the reason in the request, then freeze.';
  }
  if (run?.exit === 'timeout') return 'the oracle command timed out — a verdict cannot rest on a command that does not finish';
  // The freeze gate demands a FAILING command, which means it rewards one that
  // cannot run: a typo fails, seals into the task contract, and then fails
  // identically at every later verdict while the board reads "acceptance still
  // unmet". Failing is what the oracle was supposed to do, so the true cause
  // stays invisible. A red that never executed is not a red.
  const unrunnable = notRunnableEvidence(run);
  if (unrunnable !== undefined) {
    return `${unrunnable}. An oracle must fail because the behaviour is absent, not because the command is wrong — check the program name and freeze again`;
  }
  return undefined;
}

/**
 * The computed verdict for one verification (N2): never an assertion, always
 * derived. `tampered` outranks the run — an oracle whose digest moved is not
 * evidence of anything, whatever it now prints.
 *
 * @param {{tampered?:boolean, run?:{exit?:number|string}}} input
 * @returns {{verdict:'accept'|'reject', reason:string, category:string}}
 */
export function computeVerdict({ tampered, run } = {}) {
  if (tampered === true) {
    return {
      verdict: 'reject',
      category: 'oracle_tampered',
      reason: 'the frozen oracle changed after it was sealed — the acceptance test and the implementation now share an author, which is the correlated-failure mode this protocol exists to prevent. Restore the oracle (or re-fork it deliberately with pair_oracle) and verify again.',
    };
  }
  if (run?.exit === 0) {
    return { verdict: 'accept', category: 'oracle_green', reason: 'the frozen oracle passes against the implementation' };
  }
  if (run?.exit === 'timeout') {
    return { verdict: 'reject', category: 'oracle_timeout', reason: 'the frozen oracle timed out' };
  }
  return { verdict: 'reject', category: 'oracle_red', reason: `the frozen oracle still fails (exit ${String(run?.exit ?? 'unknown')})` };
}

/** Normalize a validated fork into the record stored on the task. */
export function freezeRecord(input, { sha, run, by, reach, forks, prior }) {
  const frozenAt = Date.now();
  // The FIRST seal's time, carried across re-freezes. The gate's ordering arm asks whether a
  // standard existed before implementation began; tightening a standard is a supported move (and
  // the defect-fork path requires it), and it moves frozenAt past every cycle the task already
  // opened — so comparing frozenAt made the arm unsatisfiable after any re-freeze (#125).
  //
  // Deliberately omitted, not inferred, when a re-freeze cannot know it: a board written before
  // this field would otherwise get "the first seal is now", which reads as a late seal and
  // re-creates the deadlock. An absent value says "unmeasurable", which the gate reports as such.
  const firstFrozenAt = prior === undefined ? frozenAt : prior.firstFrozenAt;
  return {
    readings: list(input.readings),
    chosen: text(input.chosen_reading),
    divergences: list(input.divergence_candidates),
    files: list(input.oracle_files),
    cmd: text(input.oracle_cmd),
    sha,
    redExit: run?.exit,
    redSignature: text(run?.outputSha ?? input.expected_failure),
    expectedFailure: text(input.expected_failure),
    nonGating: list(input.non_gating_arms),
    nonGatingReason: text(input.non_gating_reason),
    caseRefs: list(input.case_refs),
    forkKind: input.fork_kind === 'defect' ? 'defect' : 'interpretation',
    forks: forks ?? 1,
    frozenBy: by,
    frozenAt,
    ...(firstFrozenAt === undefined ? {} : { firstFrozenAt }),
    ...(reach === undefined ? {} : { reach }),
  };
}

/**
 * What is wrong with a declared non-gating set.
 *
 * Declaring an arm known-red and non-blocking is a SUPPORTED move, not a
 * concession — a measured session spent over two hours unable to seal because
 * the only options on offer were "an oracle that is right about everything" or
 * "no oracle", and the captain had to invent a GATING_SET convention in prose
 * to escape. Making it first-class is what stops the next team paying that
 * again. The one thing it must never be is silent: a non-gating arm is a
 * declared blind spot, and a blind spot with no reason attached is just a
 * lowered threshold wearing a different hat.
 */
export function nonGatingProblems(input = {}) {
  const arms = list(input.non_gating_arms);
  if (arms.length === 0) return [];
  const problems = [];
  if (text(input.non_gating_reason) === '') {
    problems.push('non_gating_reason: say why each declared arm cannot gate this task yet, and which task or card carries it as a hard gate instead — an undeclared exemption is indistinguishable from moving a threshold');
  }
  return problems;
}

/**
 * The warning a self-contained oracle earns. Not a refusal — a spike whose
 * deliverable really is a probe is legitimate — but it must be said out loud,
 * because such an oracle turns GREEN the moment the Driver creates the file it
 * reads and can detect nothing about the code under review.
 */
export function reachWarning(oracle) {
  if (oracle?.reach?.selfContained !== true) return undefined;
  return 'this oracle references nothing that already exists in the tree: GREEN is reachable by creating a file only the oracle reads, so it cannot detect anything about the code under review. If the deliverable really is a probe (a spike), that is fine — otherwise assert against real behaviour before the Driver starts.';
}

/**
 * Resolve the oracle one cycle must be judged against, refusing a split brain.
 *
 * The cycle carries a STAMP (`oracleSha`, copied when it opened) and the task
 * carries the LIVE record. They are two representations of one fact, so they
 * can disagree — a re-fork while a cycle is in flight would silently judge
 * work against a standard it was never shown. Rather than pick a winner, this
 * refuses: the stamp says which seal the Driver accepted, and only the task
 * record can execute, so a mismatch is a protocol error, not a preference.
 *
 * @returns {{oracle?:object, error?:string}}
 */
export function resolveCycleOracle(cycle, task) {
  if (cycle?.oracleSha === undefined) return {};
  const oracle = task?.oracle;
  if (oracle === undefined) {
    return { error: `cycle ${cycle.id} was opened against a frozen oracle that the task no longer carries — re-freeze it with pair_oracle and open a fresh cycle` };
  }
  if (oracle.sha !== cycle.oracleSha) {
    return { error: `cycle ${cycle.id} was opened against oracle ${String(cycle.oracleSha).slice(0, 12)} but the task now carries ${String(oracle.sha).slice(0, 12)} — the acceptance standard was re-forked mid-cycle. Close this cycle and open a new one against the current oracle; nothing may be judged by a standard it was not shown.` };
  }
  return { oracle };
}

/** One-line board summary of a frozen oracle (goes into the digest and pair_status). */
/**
 * The red tail a freeze letter carries, bounded.
 *
 * Measured on an archived board (issue #15): ORACLE letters are 391 KB across 68
 * freezes, and **red_tail is 50% of it** — the failing run's own output, embedded whole
 * in every freeze. Unlike an arbitration letter, whose bulk is its decision, this bulk
 * is a DIAGNOSTIC that the frozen command reproduces on demand and that the record
 * already fingerprints (`redExit`, `redSignature`). So the letter keeps a bounded head
 * and says what it elided, instead of carrying an 11 KB transcript.
 *
 * @param {string} tail - the raw output tail.
 * @param {string} [signature] - the recorded output digest, so the elision is checkable.
 * @param {number} [limit] - byte budget for the head.
 */
export function boundedRedTail(tail, signature, limit = 2048) {
  const text = String(tail ?? '');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= limit) return text;
  // Cut on a line boundary where possible: a diagnostic that ends mid-token is worse
  // than a shorter one that ends cleanly.
  const head = Buffer.from(text, 'utf8').subarray(0, limit).toString('utf8');
  const cut = head.lastIndexOf(String.fromCharCode(10));
  const kept = cut > limit / 2 ? head.slice(0, cut) : head;
  const digest = String(signature ?? '').trim();
  return kept + String.fromCharCode(10)
    + '[elided ' + (bytes - Buffer.byteLength(kept, 'utf8')) + ' of ' + bytes + ' bytes: the frozen command reproduces this output, and the record carries its exit code and signature'
    + (digest === '' ? '' : ' (' + digest.slice(0, 16) + ')') + ']';
}

export function oracleSummary(oracle) {
  if (oracle === undefined) return 'none';
  const nonGating = (oracle.nonGating ?? []).length === 0
    ? ''
    : ` · ${oracle.nonGating.length} declared non-gating arm(s): ${oracle.nonGating.join(',')}`;
  const reach = oracle.reach === undefined
    ? ''
    : ` · reach ${oracle.reach.selfContained ? 'SELF-CONTAINED (asserts nothing about existing code)' : `${oracle.reach.touches.length} existing path(s)`}`;
  // G5: a re-freeze must say WHICH kind it is, why, and how much interpretation
  // budget is left — a defect re-freeze of the same bytes and an interpretation fork
  // were indistinguishable from the number alone. The first freeze still does not
  // shout its own count (that rule is pinned by its own assertion); everything after
  // it does.
  const reason = String(oracle.defectEvidence ?? oracle.captainOverride ?? '').trim();
  const budgetLeft = oracle.budgetRemaining === undefined ? '' : `, interpretation forks left: ${oracle.budgetRemaining}`;
  const forks = (oracle.forks ?? 1) > 1
    ? ` · freeze #${oracle.forks} (kind=${oracle.forkKind === 'defect' ? 'defect' : 'interpretation'}${budgetLeft}${reason === '' ? '' : ', reason: ' + reason.slice(0, 120)})`
    : '';
  // G4: the numbers a reader can check the digest against. One session spent three
  // confusions on the seal alone: whether the digest was a file sha256, whether it had
  // moved, whether an unchanged byte count meant unchanged bytes.
  const metrics = oracle.metrics === undefined
    ? ''
    : ` · artifact ${oracle.metrics.bytes} B / ${oracle.metrics.lines} line(s)`
      + ((oracle.metrics.files ?? []).length === 1 && oracle.metrics.files[0].sha256 !== '' ? ` · file sha256 ${String(oracle.metrics.files[0].sha256).slice(0, 16)}` : '');
  return `${oracle.files.length} file(s) @${String(oracle.sha).slice(0, 12)} · cmd "${oracle.cmd}" · red exit ${String(oracle.redExit)} · ${oracle.divergences.length} divergence(s) named${nonGating}${reach}${forks}${metrics}`;
}
