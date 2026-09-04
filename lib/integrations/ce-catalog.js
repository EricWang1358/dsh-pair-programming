/**
 * The Compound Engineering catalog: one table of every skill, two lanes over
 * it, and descriptions this plugin authors rather than forwards.
 *
 * Three decisions are encoded here, and all three are load-bearing.
 *
 * 1. **Two lanes, chosen by whether a pair team is live.** CE standalone and
 *    CE inside the pair protocol are different tools with different risks.
 *    With no team running there is no single-writer invariant to protect and no
 *    completion receipt to keep fresh, so `ce-work` and the shipping family are
 *    exactly what CE is for — the whole set is served. The moment a team is
 *    live, those same skills would put a second execution loop behind the same
 *    worktree, so the lane narrows to the analytical slice and every body
 *    carries an ownership boundary. Nobody has to remember to switch.
 *
 * 2. **The set is closed either way.** A CE upgrade that adds a skill exposes
 *    nothing until a human adds a row here, in either lane.
 *
 * 3. **The descriptions are ours.** A model-facing catalog costs repeated input
 *    tokens on EVERY step, scaled by skill count times description length.
 *    CE's own frontmatter for all 33 runs 7,487 characters (~1,870 tokens per
 *    step, forever); the routing lines below run about a third of that and say
 *    the one thing a router needs. The full CE text still arrives verbatim on
 *    load — this is catalog economy, not a rewrite of the skill.
 *
 * Pure data plus pure helpers: no fs, no host, unit-testable.
 *
 * @module dsh-pair-programming/integrations/ce-catalog
 */
import { createHash } from 'node:crypto';

/** The plugin name inside CE's own manifest — the only accepted identity. */
export const CE_PLUGIN_NAME = 'compound-engineering';

/** The CE release this catalog was reviewed against. */
export const CE_REVIEWED_VERSION = '3.24.0';

/** Skill count of the reviewed release. A different count trips human review. */
export const CE_REVIEWED_SKILL_COUNT = 33;

/**
 * Rank for every CE candidate. Higher is WEAKER: a project-local or user skill
 * of the same name always wins, so nothing here can shadow first-party content.
 * `BUNDLED_SKILL_RANK` in `dsh-skill` is 600; this sits below it.
 */
export const CE_SKILL_RANK = 700;

/**
 * Every skill in the reviewed release, with the routing line we publish and
 * where it is allowed to appear.
 *
 * `pairSurface` is what this row does while a pair team is LIVE:
 *   'user'  — user-gesture only (`modelInvocable: false`): zero repeated
 *             tokens, reachable when a human types `/<name>`.
 *   'model' — in the seat-facing catalog, loadable mid-cycle.
 *   'deny'  — owns an execution loop or a shipping action. Never served while
 *             a team is live, and loading one from elsewhere refuses the gate.
 *   'none'  — not dangerous, just not worth catalog tokens inside a cycle.
 */
export const CE_SKILLS = Object.freeze([
  /* ---- analytical: the pair-mode catalog ------------------------------- */
  { name: 'ce-code-review', pairSurface: 'model', description: 'Review a change into findings with a detection condition, cited evidence, and a confidence. Never edits.' },
  { name: 'ce-proof', pairSurface: 'model', description: 'Check each claim against the evidence that is supposed to support it.' },
  { name: 'ce-doc-review', pairSurface: 'model', description: 'Check documentation against the code it describes. Never edits code.' },
  { name: 'ce-pov', pairSurface: 'model', description: 'Re-read the same change from a deliberately different stance to surface what consensus hid.' },
  { name: 'ce-debug', pairSurface: 'model', description: 'Localise a fault and eliminate hypotheses. Diagnosis only, no fix.' },
  { name: 'ce-explain', pairSurface: 'model', description: 'Explain what a piece of code or a change does and what it can affect.' },
  { name: 'ce-simplify-code', pairSurface: 'model', description: 'Propose simplifications with reasons. Suggests; does not rewrite.' },

  /* ---- constructive: user gesture while pairing ------------------------ */
  { name: 'ce-brainstorm', pairSurface: 'user', description: 'Press a vague idea into executable requirements; asks questions, writes no code.' },
  { name: 'ce-ideate', pairSurface: 'user', description: 'Generate and rank candidate approaches for an open problem. Opening move, not a decision.' },
  { name: 'ce-strategy', pairSurface: 'user', description: 'Turn a pile of requests into one route judgement across releases.' },
  { name: 'ce-plan', pairSurface: 'user', description: 'Draft a stepwise implementation plan, ready to become task cards.' },
  { name: 'ce-compound', pairSurface: 'user', description: 'Retrospective capture: at most one learning, and only if it survives a counterfactual.' },

  /* ---- execution and shipping: solo only ------------------------------- */
  { name: 'ce-work', pairSurface: 'deny', description: 'Implement a plan or a concrete build request end-to-end, verifying locally as it goes.' },
  { name: 'lfg', pairSurface: 'deny', description: 'Autonomous pipeline: build, verify, commit, push and open a PR with no check-ins.' },
  { name: 'ce-commit', pairSurface: 'deny', description: 'Write a git commit with a message that explains the value, not the diff.' },
  { name: 'ce-commit-push-pr', pairSurface: 'deny', description: 'Commit, push and open a PR; also for writing or rewriting a PR body.' },
  { name: 'ce-worktree', pairSurface: 'deny', description: 'Create or attach an isolated git worktree for a branch, PR or commit.' },
  { name: 'ce-babysit-pr', pairSurface: 'deny', description: 'Watch an open GitHub PR over time until it is merge-ready.' },
  { name: 'ce-resolve-pr-feedback', pairSurface: 'deny', description: 'Address review feedback already left on a PR. Not for reviewing before feedback exists.' },
  { name: 'ce-promote', pairSurface: 'deny', description: 'Draft launch or promotion copy for something already shipped.' },
  { name: 'ce-sweep', pairSurface: 'deny', description: 'Sweep Slack/GitHub feedback sources into an actionable plan, acknowledging at source.' },

  /* ---- everything else: solo only, no protocol risk --------------------- */
  { name: 'ce-optimize', pairSurface: 'none', description: 'Run metric-driven optimization loops against a measurable outcome.' },
  { name: 'ce-polish', pairSurface: 'none', description: 'Refine a working feature through live browser feedback before shipping.' },
  { name: 'ce-prototype', pairSurface: 'none', description: 'Build a throwaway sketch to settle how something should work or feel.' },
  { name: 'ce-product-pulse', pairSurface: 'none', description: 'Generate a time-windowed product pulse report from configured signals.' },
  { name: 'ce-riffrec-feedback-analysis', pairSurface: 'none', description: 'Turn a recorded capture (screen, voice, notes) into bug and requirement evidence.' },
  { name: 'ce-handoff', pairSurface: 'none', description: 'Write a session handoff, or resume from one, when work must continue elsewhere.' },
  { name: 'ce-setup', pairSurface: 'none', description: 'Check Compound Engineering health and repo-local configuration.' },
  { name: 'ce-retune', pairSurface: 'none', description: 'Retune a skill corpus for a new model, measurement-first against a baseline.' },
  { name: 'ce-dogfood', pairSurface: 'none', description: 'Diff-scoped browser QA of the active branch, fixing small breakages as it goes.' },
  { name: 'ce-compound-refresh', pairSurface: 'none', description: 'Audit captured learnings against the current codebase for drift and overlap.' },
  { name: 'ce-test-browser', pairSurface: 'none', description: 'Run browser tests for the pages this branch or PR affects.' },
  { name: 'ce-test-xcode', pairSurface: 'none', description: 'Test an iOS app in a simulator when changes need simulator evidence.' },
]);

/** The pair-mode allowlist: rows this plugin serves while a team is live. */
export const CE_ALLOWLIST = Object.freeze(
  CE_SKILLS.filter(row => row.pairSurface === 'user' || row.pairSurface === 'model')
    .map(row => Object.freeze({ name: row.name, surface: row.pairSurface, description: row.description })),
);

/**
 * Skills that own an execution loop or a shipping action. Never served while a
 * pair team is live; loading one from any provider during a task window
 * refuses that task's gate credential.
 */
export const CE_WRITE_LANE = Object.freeze(CE_SKILLS.filter(row => row.pairSurface === 'deny').map(row => row.name));

/** Reviewed but not adopted into the pair lane. Solo-only; not a violation. */
export const CE_DEFERRED = Object.freeze(CE_SKILLS.filter(row => row.pairSurface === 'none').map(row => row.name));

/** Pair-lane allowlisted names, for membership tests. */
export const CE_ALLOWED_NAMES = Object.freeze(CE_ALLOWLIST.map(entry => entry.name));

/** Every CE skill name this build knows about, from any lane. */
export const CE_KNOWN_NAMES = Object.freeze(CE_SKILLS.map(row => row.name));

/** Whether a skill name is one the pair lane will serve. */
export function isAllowed(name) {
  return CE_ALLOWED_NAMES.includes(name);
}

/** Whether a skill name owns a write scheduler or a shipping tail. */
export function isWriteLane(name) {
  return CE_WRITE_LANE.includes(name);
}

/** Whether a skill name belongs to Compound Engineering at all. */
export function isCeSkill(name) {
  return CE_KNOWN_NAMES.includes(name);
}

/**
 * Pair-mode lanes (a team is live).
 *
 * `off` — nothing.
 * `captain` — user-gesture surface only; the model catalog stays empty.
 * `advisory` — adds the analytical skills to the seat-facing catalog.
 * `full` — as advisory, plus the phase-bound persona push.
 */
export function entriesForLane(lane) {
  if (lane === 'captain') return CE_ALLOWLIST.filter(entry => entry.surface === 'user');
  if (lane === 'advisory' || lane === 'full') return [...CE_ALLOWLIST];
  return [];
}

/**
 * Solo lanes (no pair team is live in this workspace).
 *
 * `off` — nothing.
 * `gesture` — every skill, user-invocable only: zero repeated tokens, and a
 *   human types `/ce-work`. The cheap way to keep CE at hand.
 * `curated` — the pair allowlist, with its surfaces, even outside a team.
 * `full` — every skill in the model catalog. The convenient way, and the one
 *   that actually costs something on every step.
 */
export function entriesForSoloLane(lane) {
  if (lane === 'gesture') return CE_SKILLS.map(row => ({ name: row.name, surface: 'user', description: row.description }));
  if (lane === 'curated') return [...CE_ALLOWLIST];
  if (lane === 'full') return CE_SKILLS.map(row => ({ name: row.name, surface: 'model', description: row.description }));
  return [];
}

/** Resolve the entries for one workspace state. */
export function entriesFor({ lane, soloLane, teamLive }) {
  return teamLive ? entriesForLane(lane) : entriesForSoloLane(soloLane);
}

/**
 * What one set of entries costs in a model catalog.
 *
 * The catalog is a durable message resent on every step, so its size is
 * repeated input cost for the life of a session — the one number that decides
 * whether a lane is worth turning on.
 *
 * @returns {{skills:number, chars:number, approxTokens:number}}
 */
export function costOf(entries) {
  const model = (entries ?? []).filter(entry => entry.surface === 'model');
  const chars = model.reduce((sum, entry) => sum + entry.name.length + entry.description.length, 0);
  return { skills: model.length, chars, approxTokens: Math.ceil(chars / 3.8) };
}

/** What one pair lane costs in a seat-facing catalog. */
export function catalogCost(lane) {
  return costOf(entriesForLane(lane));
}

/** What one solo lane costs in the main session's catalog. */
export function soloCatalogCost(lane) {
  return costOf(entriesForSoloLane(lane));
}

/**
 * A stable digest of exactly what this build would expose, in both lanes. It
 * rides the probe fingerprint, so an edit to this table invalidates a recorded
 * "linked" state the same way a CE upgrade does — the credential covers our
 * own side too.
 */
export function allowlistDigest() {
  const payload = CE_SKILLS.map(row => `${row.name}:${row.pairSurface}:${row.description}`).join('\n');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}
