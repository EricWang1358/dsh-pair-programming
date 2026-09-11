/**
 * Risk register: the lifecycle of one risk ticket.
 *
 *   OPEN ──Driver fixes + evidence──► MITIGATED ──Navigator confirms──► CLOSED
 *     │                                  ▲
 *     └──Captain rules it a false alarm──┘ (marked WONTFIX with rationale)
 *
 * Severity gates: a P0 blocks the current cycle; a P1 blocks task completion;
 * a P2 may be deferred to the backlog. Pure logic — unit-testable.
 *
 * @module dsh-pair-programming/protocol/risks
 */

export const SEVERITIES = Object.freeze(['P0', 'P1', 'P2']);
/**
 * What a ticket is about, which decides what it may halt.
 *
 * Measured failure: in a full v3 session every P0 raised was about the
 * acceptance instrument (the pixel gate self-certifying, the gate not
 * asserting its capture dimensions) — and because a P0 blocked all new cycles
 * regardless of subject, two hours of product work were held behind defects in
 * the measuring device. Nobody was idle and nothing shipped.
 *
 * A defect in the instrument must stop us TRUSTING a result; it must not stop
 * us PRODUCING one. Product defects keep the old, total block.
 */
export const RISK_SCOPES = Object.freeze(['product', 'instrument']);
export const RISK_STATUSES = Object.freeze(['OPEN', 'MITIGATED', 'CLOSED', 'WONTFIX']);

/** Open a new risk ticket; returns the record. */
export function openRisk(protocol, { severity, scenario, trigger, suggestion, raisedBy, scope, taskId }) {
  if (!SEVERITIES.includes(severity)) {
    throw new Error(`invalid risk severity "${severity}" (expected ${SEVERITIES.join('/')})`);
  }
  const subject = RISK_SCOPES.includes(scope) ? scope : 'product';
  const risk = {
    id: `r-${protocol.risks.length + 1}-${Date.now().toString(36)}`,
    severity,
    scenario,
    trigger,
    suggestion,
    raisedBy,
    scope: subject,
    // The card this came from, when the raiser named one. Absent means "the whole team",
    // which is what every ticket written before this field meant.
    ...(taskId === undefined ? {} : { taskId }),
    status: 'OPEN',
    openedAt: Date.now(),
  };
  protocol.risks.push(risk);
  protocol.stats.attacks += 1;
  return risk;
}

/** Mark a risk mitigated (Driver fixed, evidence attached). */
export function mitigateRisk(protocol, riskId, evidence) {
  const risk = requireRisk(protocol, riskId);
  if (risk.status !== 'OPEN') throw new Error(`risk "${riskId}" is ${risk.status}, not OPEN`);
  risk.status = 'MITIGATED';
  risk.mitigationEvidence = evidence;
  risk.mitigatedAt = Date.now();
  return risk;
}

/**
 * Paths this team authored while working the task: proposal file sets and any
 * Driver-written RED tests. Oracle files are deliberately EXCLUDED — they were
 * frozen by a role that had not seen the implementation, which is exactly the
 * independence a closing artifact needs.
 */
export function teamAuthoredPaths(protocol) {
  const out = new Set();
  const add = (v) => { if (typeof v === 'string' && v.trim() !== '') out.add(normalizePath(v)); };
  for (const cycle of protocol.cycles ?? []) {
    for (const f of cycle.proposal?.files ?? []) add(f);
    if (cycle.red?.fromOracle !== true) for (const f of cycle.red?.test_files ?? []) add(f);
  }
  return out;
}

function normalizePath(value) {
  return String(value).split('\\').join('/').replace(/^\.\//, '').toLowerCase();
}

/**
 * N3: what is wrong with a proposed P0/P1 closure.
 *
 * The measured failure this prevents: a Challenger ticket named the exact
 * defect that later killed the task ("the emitted docname will not match what
 * the acceptance test asserts"), and it was CLOSED with "pinned by new tests"
 * — tests the same team had just written under the same wrong assumption. A
 * blocking risk closes on something the team could not have fabricated: a
 * command, its exit code, and at least one artifact it did not author for
 * this task. P2 tickets still close on a sentence; they block nothing.
 */
export function closeProblems(protocol, risk, input = {}) {
  const problems = [];
  if (risk.severity === 'P2') return problems;
  const cmd = String(input.closingCmd ?? '').trim();
  if (cmd === '') {
    problems.push(`closing_cmd: a ${risk.severity} closes on a command that would FAIL if the risk were real — name it`);
  }
  if (input.closingExit !== 0) {
    problems.push(`closing_exit: record the exit code of that command; ${risk.severity} closure needs a passing run (got ${String(input.closingExit ?? 'nothing')})`);
  }
  const paths = (input.closingPaths ?? []).map(v => String(v ?? '').trim()).filter(Boolean);
  if (paths.length === 0) {
    problems.push('closing_paths: name the artifact(s) the command exercised, so the closure can be audited');
  } else {
    const authored = teamAuthoredPaths(protocol);
    if (paths.every(path => authored.has(normalizePath(path)))) {
      problems.push(`closing_paths: every cited artifact (${paths.join(', ')}) is a file this team wrote while working the task — closing a ${risk.severity} against your own new tests re-asserts the assumption the ticket doubted. Cite the frozen oracle, a pre-existing suite, or an independent probe.`);
    }
  }
  return problems;
}

/**
 * Close a mitigated risk (Navigator confirmed). For P0/P1 the closure must
 * carry executable evidence — see closeProblems.
 */
export function closeRisk(protocol, riskId, evidence, artifact = {}) {
  const risk = requireRisk(protocol, riskId);
  if (risk.status !== 'MITIGATED') throw new Error(`risk "${riskId}" is ${risk.status}, not MITIGATED`);
  const problems = closeProblems(protocol, risk, artifact);
  if (problems.length > 0) {
    throw new Error(`a ${risk.severity} closure needs an executable artifact, not a statement:\n- ${problems.join('\n- ')}`);
  }
  risk.status = 'CLOSED';
  risk.closeEvidence = evidence;
  if (String(artifact.closingCmd ?? '').trim() !== '') {
    risk.closingArtifact = {
      cmd: String(artifact.closingCmd).trim(),
      exit: artifact.closingExit,
      paths: (artifact.closingPaths ?? []).map(v => String(v)),
    };
  }
  risk.closedAt = Date.now();
  return risk;
}

/**
 * Rule a risk a false alarm, or that a mitigation already in hand is the whole remedy
 * (Captain arbitration). For a MITIGATED ticket this is the disposition that says "no
 * independent artifact will be produced" — the rationale carries why.
 *
 * Measured dead-end (SG-career, 2026-09-11): a P0 was MITIGATED, openBlockingRisks counted
 * it as blocking, closeRisk demanded the P0/P1 executable artifact the team could not
 * produce, and this guard refused anything that was not OPEN — so the ticket blocked
 * completion with no disposition path left. A ticket a captain can rule on is OPEN or
 * MITIGATED; CLOSED and WONTFIX are already settled rulings and stay refused.
 */
export function wontfixRisk(protocol, riskId, rationale) {
  const risk = requireRisk(protocol, riskId);
  if (!['OPEN', 'MITIGATED'].includes(risk.status)) throw new Error(`risk "${riskId}" is ${risk.status}, already settled`);
  risk.status = 'WONTFIX';
  risk.wontfixRationale = rationale;
  risk.closedAt = Date.now();
  return risk;
}

/**
 * All risks still blocking task completion.
 *
 * MITIGATED counts as blocking: v2 cleared the gate at MITIGATED, so a P0 could
 * be parked with a sentence of `mitigationEvidence` and the task completed
 * anyway — measured on i2, where the P0 that named the actual defect was
 * flipped to MITIGATED 39 seconds after the GO and never confirmed. Only a
 * confirmed CLOSED (which now needs an artifact) or an explicit WONTFIX ruling
 * clears the way.
 */
export function openBlockingRisks(protocol, severities = ['P0', 'P1'], taskId = undefined) {
  return protocol.risks.filter(r => (r.status === 'OPEN' || r.status === 'MITIGATED') && severities.includes(r.severity) && blocksCard(r, taskId));
}

/**
 * Whether one ticket blocks one card.
 *
 * A ticket may name the card it came from (`pair_risk` task_id). An UNATTRIBUTED ticket
 * blocks EVERY card: the conservative default, and what every board written before the
 * field means. Passing no taskId asks the team-wide question and matches every ticket.
 *
 * Measured failure (SG-career, 2026-09-11): a P0 found on one card made every OTHER card
 * ungatable and unverifiable, and with one task per seat nobody who could resolve it was
 * working on that card — the issue was reported as a deadlock, not as strictness.
 */
function blocksCard(risk, taskId) {
  return taskId === undefined || risk.taskId === undefined || risk.taskId === taskId;
}

/** Whether any P0 risk is open, regardless of what it is about. */
export function hasOpenP0(protocol) {
  return protocol.risks.some(r => r.status === 'OPEN' && r.severity === 'P0');
}

/** The scope of one ticket; tickets written before scopes existed are product. */
export function scopeOf(risk) {
  return RISK_SCOPES.includes(risk?.scope) ? risk.scope : 'product';
}

/**
 * Open P0s that must stop new implementation: product defects only.
 * An instrument defect means we cannot yet believe a verdict — it says nothing
 * about whether the Driver may write the next line of code.
 */
export function blocksImplementation(protocol, taskId = undefined) {
  return (protocol.risks ?? []).filter(r => r.status === 'OPEN' && r.severity === 'P0' && scopeOf(r) === 'product' && blocksCard(r, taskId));
}

/**
 * Open P0s that must stop us acting on a verdict: any P0 at all. A product P0
 * makes the thing under test untrustworthy; an instrument P0 makes the
 * measurement untrustworthy. Either way an ACCEPT would mean nothing.
 */
export function blocksVerification(protocol, taskId = undefined) {
  return (protocol.risks ?? []).filter(r => r.status === 'OPEN' && r.severity === 'P0' && blocksCard(r, taskId));
}

/**
 * Raise budget: only OPEN non-P0 tickets count against the cap — a P0 is never
 * blocked (I5). `closeFirst` orders by (P2 first, openedAt, id) so a refusal is
 * reproducible. A dirty cap throws rather than passing silently: YAML has no
 * schema for maxOpenRisks, so this predicate is the backstop. `cap === 0` is
 * legal and freezes non-P0 raises (kill switch), while the settings surface
 * rejects 0 — the same asymmetry as the sibling budget fields.
 */
export function raiseBudgetExhausted(protocol, cap) {
  if (!Number.isInteger(cap) || cap < 0) throw new Error(`maxOpenRisks must be an integer >= 0 (got ${String(cap)})`);
  const open = protocol.risks.filter(r => r.status === 'OPEN' && r.severity !== 'P0');
  const rank = (r) => (r.severity === 'P2' ? 0 : 1);
  const cheapFirst = [...open].sort((a, b) => rank(a) - rank(b) || (a.openedAt ?? 0) - (b.openedAt ?? 0) || String(a.id).localeCompare(String(b.id)));
  return { exhausted: open.length >= cap, openNonP0: open.length, cap, closeFirst: cheapFirst.slice(0, 5).map(({ id, severity }) => ({ id, severity })) };
}

/** The actionable refusal a budget-blocked raise gets back. */
export function raiseBudgetMessage(budget) {
  const names = budget.closeFirst.map(r => `${r.id}(${r.severity})`).join(', ');
  return `risk budget exhausted: ${budget.openNonP0} open non-P0 ticket(s) at cap ${budget.cap} — clear one first (close / mitigate / wontfix). Cheapest to clear, oldest P2 first: ${names}. A P0 bypasses this budget.`;
}

function requireRisk(protocol, riskId) {
  const risk = protocol.risks.find(r => r.id === riskId);
  if (risk === undefined) throw new Error(`unknown risk "${riskId}"`);
  return risk;
}
