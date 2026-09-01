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
export const RISK_STATUSES = Object.freeze(['OPEN', 'MITIGATED', 'CLOSED', 'WONTFIX']);

/** Open a new risk ticket; returns the record. */
export function openRisk(protocol, { severity, scenario, trigger, suggestion, raisedBy }) {
  if (!SEVERITIES.includes(severity)) {
    throw new Error(`invalid risk severity "${severity}" (expected ${SEVERITIES.join('/')})`);
  }
  const risk = {
    id: `r-${protocol.risks.length + 1}-${Date.now().toString(36)}`,
    severity,
    scenario,
    trigger,
    suggestion,
    raisedBy,
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

/** Close a mitigated risk (Navigator confirmed). */
export function closeRisk(protocol, riskId, evidence) {
  const risk = requireRisk(protocol, riskId);
  if (risk.status !== 'MITIGATED') throw new Error(`risk "${riskId}" is ${risk.status}, not MITIGATED`);
  risk.status = 'CLOSED';
  risk.closeEvidence = evidence;
  risk.closedAt = Date.now();
  return risk;
}

/** Rule a risk a false alarm (Captain arbitration). */
export function wontfixRisk(protocol, riskId, rationale) {
  const risk = requireRisk(protocol, riskId);
  if (risk.status !== 'OPEN') throw new Error(`risk "${riskId}" is ${risk.status}, not OPEN`);
  risk.status = 'WONTFIX';
  risk.wontfixRationale = rationale;
  risk.closedAt = Date.now();
  return risk;
}

/** All risks currently blocking, filtered by the severities that block. */
export function openBlockingRisks(protocol, severities = ['P0', 'P1']) {
  return protocol.risks.filter(r => r.status === 'OPEN' && severities.includes(r.severity));
}

/** Whether any P0 risk is open (blocks the current cycle). */
export function hasOpenP0(protocol) {
  return protocol.risks.some(r => r.status === 'OPEN' && r.severity === 'P0');
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
