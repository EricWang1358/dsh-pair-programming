/**
 * What the independent seats changed, read only from recorded board facts. No model calls, no inferred intent:
 * a count here says a pushback or fix was recorded, not that it prevented a defect. Later verdicts overwrite a
 * cycle's review/verify, so totals come from protocol.stats and per-cycle rejections; the notes list only what
 * is still on the board.
 */
const cut = (value, max = 240) => typeof value === 'string' ? value.slice(0, max) : '';
const time = value => Number.isFinite(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const SETTLED = ['accept', 'checkpoint'];

function riskSummary(risks, role) {
  const own = risks.filter(r => r.raisedBy === role);
  return { total: own.length, bySeverity: ['P0', 'P1', 'P2'].map(severity => {
    const tier = own.filter(r => r.severity === severity);
    return { severity, handled: tier.filter(r => ['MITIGATED', 'CLOSED'].includes(r.status)).length,
      open: tier.filter(r => r.status === 'OPEN').length, dismissed: tier.filter(r => r.status === 'WONTFIX').length };
  }) };
}

export function reviewValue(team) {
  const protocol = team.protocol ?? {}, cycles = protocol.cycles ?? [], stats = protocol.stats ?? {}, risks = protocol.risks ?? [];
  const members = (team.members ?? []).filter(m => m.status !== 'removed');
  const roleOf = name => members.find(m => m.name === name)?.role ?? (name === 'captain' ? 'captain' : 'navigator');
  const settled = cycles.filter(c => SETTLED.includes(c.verify?.verdict));
  const repairs = cycles.flatMap(c => (c.verificationRepairs ?? []).map(repair => ({ cycle: c, repair })));
  const notes = [];
  const note = (kind, role, cycle, text, at, extra = {}) => notes.push({ kind, role, ref: cycle.id, task: cycle.taskId ?? null, text: cut(text), at: time(at), ...extra });
  for (const c of cycles) {
    if (c.review?.verdict === 'no_go') note('noGo', 'navigator', c, c.review.feedback?.observation ?? c.review.required_changes, c.review.at);
    if (c.verify?.verdict === 'reject') note('reject', 'navigator', c, c.verify.feedback?.observation ?? (Array.isArray(c.verify.evidence) ? c.verify.evidence[0] : ''), c.verify.at);
    if (c.verify?.beyondRequest) note('scope', 'navigator', c, c.verify.beyondRequest, c.verify.at);
    if (c.verify?.preexistingAtRisk) note('preexisting', 'navigator', c, c.verify.preexistingAtRisk, c.verify.at);
    if (SETTLED.includes(c.verify?.verdict) && count(c.rejections) > 0) note('fixed', 'navigator', c, '', c.verify.at, { count: c.rejections });
  }
  // review/verify are overwritten by the next verdict; the appended record is what keeps a
  // rejection that was later fixed on the board. An entry the current verdict already shows is
  // skipped, and whatever is left of `rejections` is reported as undated rather than invented.
  let undatedPushbacks = 0;
  for (const c of cycles) {
    const recorded = (c.pushbacks ?? []).filter(p => ['no_go', 'reject'].includes(p.kind) && time(p.at) !== null);
    for (const push of recorded) {
      const live = push.kind === 'no_go'
        ? c.review?.verdict === 'no_go' && c.review.at === push.at
        : c.verify?.verdict === 'reject' && c.verify.at === push.at;
      if (!live) note(push.kind === 'no_go' ? 'noGo' : 'reject', 'navigator', c, push.observation, push.at, push.category === undefined ? {} : { category: push.category });
    }
    const liveKind = c.review?.verdict === 'no_go' ? 'no_go' : c.verify?.verdict === 'reject' ? 'reject' : null;
    const liveAt = liveKind === 'no_go' ? c.review.at : c.verify?.at;
    const unrecordedLive = liveKind !== null && !recorded.some(p => p.kind === liveKind && p.at === liveAt) ? 1 : 0;
    undatedPushbacks += Math.max(0, count(c.rejections) - recorded.length - unrecordedLive);
  }
  for (const { cycle, repair } of repairs) note('repair', roleOf(repair.by), cycle, repair.reason, repair.at);
  for (const r of risks) if (r.raisedBy === 'navigator' || r.raisedBy === 'challenger') {
    notes.push({ kind: 'risk', role: r.raisedBy, ref: cut(r.id, 80), task: null, severity: cut(r.severity, 4), status: cut(r.status, 12), text: cut(r.scenario), at: time(r.openedAt) });
  }
  return {
    roles: { navigator: members.some(m => m.role === 'navigator'), challenger: members.some(m => m.role === 'challenger') },
    oracles: { tasks: (team.tasks ?? []).filter(t => t.oracle).length, cases: (team.tasks ?? []).reduce((n, t) => n + (t.oracle?.caseRefs?.length ?? 0), 0) },
    noGo: count(stats.noGo), rejects: count(stats.reject), repairs: repairs.length,
    settled: settled.length, firstTry: settled.filter(c => !(count(c.rejections) > 0)).length, fixedAfterPushback: settled.filter(c => count(c.rejections) > 0).length,
    undatedPushbacks,
    scope: cycles.filter(c => c.verify?.beyondRequest).length, preexisting: cycles.filter(c => c.verify?.preexistingAtRisk).length,
    reasons: Object.entries(stats.reasons ?? {}).filter(([, n]) => count(n) > 0).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key, n]) => ({ key: cut(key, 40), count: n })),
    risks: { navigator: riskSummary(risks, 'navigator'), challenger: riskSummary(risks, 'challenger') },
    notes: notes.filter(n => n.at !== null).sort((a, b) => b.at - a.at).slice(0, 14),
  };
}
