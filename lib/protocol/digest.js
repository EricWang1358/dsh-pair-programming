/**
 * The board digest (R2): everything a member needs to work one cycle, and
 * nothing it merely accumulated.
 *
 * Why this exists. v2 members were durable continuable subagents whose context
 * grew monotonically, and every internal tool call replayed the whole thing.
 * One measured instance: the Driver alone consumed 7.10M input tokens across
 * five wakes while a single agent completed the same task on 138k. The persona
 * was never the cost — it is ~1.1k tokens and prefix-cached — the transcript
 * was. A member respawned per cycle from this digest starts at a few thousand
 * tokens instead of millions, and loses nothing that the board did not already
 * hold: the board IS the team's memory, which is the reason it exists.
 *
 * Pure string building — unit-testable, no fs, no imports beyond the oracle
 * summary helper.
 *
 * @module dsh-pair-programming/protocol/digest
 */
import { oracleSummary, reachWarning } from './oracle.js';
import { nextObligation, obligationLine } from './obligation.js';
import { openDisclosures } from './disclosure.js';

/** Target size for one member's board digest. */
export const DIGEST_BUDGET_CHARS = 8000;

const trim = (value, max) => {
  const text = String(value ?? '').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};

/**
 * Build the digest one member is respawned with.
 *
 * Sections are emitted in priority order and dropped from the bottom when the
 * budget is exceeded, so the task and its oracle always survive; the note says
 * what was cut rather than letting a silent truncation look like the whole
 * board.
 *
 * @param {object} team - the durable team record.
 * @param {{memberName?:string, role?:string, budget?:number}} [opts]
 */
export function boardDigest(team, opts = {}) {
  const budget = opts.budget ?? DIGEST_BUDGET_CHARS;
  const protocol = team.protocol ?? {};
  const cycles = protocol.cycles ?? [];
  const cycle = cycles[cycles.length - 1];
  const task = team.tasks?.find(t => t.id === cycle?.taskId)
    ?? team.tasks?.find(t => t.status === 'claimed' || t.status === 'in_progress');
  const blockers = (protocol.risks ?? []).filter(r => r.status === 'OPEN' || r.status === 'MITIGATED');

  const sections = [];
  sections.push([
    `# Board digest — team "${team.name}" (${team.mode}, phase ${protocol.phase})`,
    obligationLine(nextObligation(team)),
    `You are ${opts.memberName ?? 'a member'}${opts.role ? ` (${opts.role})` : ''}. This digest replaces the transcript of earlier cycles: the board is the team memory, so work from what is written here and read the repository for the rest.`,
    `Goal: ${trim(team.goal, 600)}`,
  ].join('\n'));

  if (task !== undefined) {
    sections.push([
      `## Task ${task.id} [${task.status}${task.assignee ? ` @${task.assignee}` : ''}]`,
      trim(task.subject, 300),
      task.description ? trim(task.description, 1800) : '',
      task.story?.acceptance_criteria?.length ? `Acceptance criteria:\n${task.story.acceptance_criteria.map(a => `- ${trim(a, 220)}`).join('\n')}` : '',
    ].filter(Boolean).join('\n'));

    sections.push([
      '## Frozen acceptance oracle',
      oracleSummary(task.oracle),
      task.oracle === undefined
        ? 'No oracle yet — the Navigator must run pair_oracle before the Driver implements.'
        : [
          `Chosen reading: ${trim(task.oracle.chosen, 400)}`,
          `Divergence candidates still to close: ${task.oracle.divergences.map(d => trim(d, 200)).join(' | ')}`,
          ...(reachWarning(task.oracle) === undefined ? [] : [`REACH WARNING: ${reachWarning(task.oracle)}`]),
          'These files are SEALED. Editing them is an automatic REJECT at verification.',
          `Sealed files: ${task.oracle.files.join(', ')}`,
        ].join('\n'),
    ].join('\n'));
  }

  if (cycle !== undefined) {
    sections.push([
      `## Current cycle ${cycle.id} — step ${cycle.step}`,
      cycle.proposal ? `Intent: ${trim(cycle.proposal.intent, 500)}` : '',
      cycle.proposal?.files?.length ? `Files: ${cycle.proposal.files.join(', ')}` : '',
      cycle.review ? `Review: ${cycle.review.verdict.toUpperCase()}${cycle.review.auto ? ' (auto, small step)' : ''}${cycle.review.conditions ? ` — conditions: ${trim(cycle.review.conditions, 400)}` : ''}` : '',
      cycle.verify ? `Last verdict: ${cycle.verify.verdict.toUpperCase()}${cycle.verify.computed ? ' (computed from the frozen oracle)' : ''}${cycle.verify.category ? ` [${cycle.verify.category}]` : ''}` : '',
    ].filter(Boolean).join('\n'));
  }

  if (blockers.length > 0) {
    sections.push([
      '## Unresolved risk tickets (these block task completion)',
      ...blockers.map(r => `- ${r.id} ${r.severity} ${r.status}: ${trim(r.scenario, 300)}`),
      'A P0/P1 closes only on an executable artifact the team did not author for this task.',
    ].join('\n'));
  }

  const disclosures = openDisclosures(team);
  if (disclosures.length > 0) {
    sections.push([
      '## Open disclosures (Captain must rule on each before successful stop)',
      ...disclosures.map(item => `- ${item.ref} [${item.kind}]: ${trim(item.text, 320)}`),
    ].join('\n'));
  }

  const decisions = (protocol.decisions ?? []).slice(-3);
  if (decisions.length > 0) {
    sections.push([
      '## Recent arbitrations',
      ...decisions.map(d => `- ${d.id} ${trim(d.conflictRef, 80)} -> ${trim(d.decision, 240)}`),
    ].join('\n'));
  }

  const lessons = team.processLessons;
  if (lessons?.keep?.length || lessons?.try?.length) {
    sections.push([
      '## Carried lessons',
      ...(lessons.keep ?? []).slice(0, 3).map(k => `- keep: ${trim(k, 220)}`),
      ...(lessons.try ?? []).slice(0, 3).map(t => `- try: ${trim(t, 220)}`),
    ].join('\n'));
  }

  const kept = [];
  let size = 0;
  let dropped = 0;
  for (const section of sections) {
    if (size + section.length + 2 > budget && kept.length > 0) { dropped += 1; continue; }
    kept.push(section);
    size += section.length + 2;
  }
  if (dropped > 0) kept.push(`[digest truncated: ${dropped} lower-priority section(s) dropped — read the board at the state directory for the rest]`);
  return kept.join('\n\n');
}
