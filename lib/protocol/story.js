/**
 * User-story shape + the machine-checkable slice of INVEST.
 *
 * Tasks in this protocol are captured as user stories ("As a <role>, I want
 * <intent>, so that <benefit>" + acceptance criteria — the Card/Confirmation
 * of the 3 Cs). Some INVEST letters need human judgment (Negotiable, the
 * semantic part of Valuable) and live in the role prompts; the letters checked
 * here are the mechanical, hard-review requirements the course lecturer applies:
 *
 * - role is a specific real role, never a generalized "As a user" (no "u");
 * - the benefit is not a synonymous restatement of the goal (lexical parity);
 * - acceptance criteria exist, so the story is Testable / confirmable;
 * - the story carries a subject (the Card summary).
 *
 * Pure logic, no I/O — unit-testable.
 *
 * @module dsh-pair-programming/protocol/story
 */

const GENERIC_ROLES = new Set([
  'user', 'users', 'someone', 'anyone', 'a user', 'people', 'person', 'they',
  '用户', '使用者', '任何人', '某人', '大家',
]);

const STOPWORDS_EN = new Set([
  'a', 'an', 'the', 'to', 'and', 'or', 'for', 'of', 'in', 'on', 'my', 'your', 'our',
  'i', 'it', 'that', 'this', 'can', 'will', 'be', 'is', 'are', 'so', 'as', 'want',
  'need', 'needs', 'use', 'using', 'with', 'me',
]);
const CJK = /[\u4e00-\u9fff]/;

/** Strip the story boilerplate prefix ("As a ...", "作为 ...") from a role. */
export function normalizeRole(role) {
  return String(role ?? '')
    .trim()
    .replace(/^as\s+a[n]?\s+/i, '')
    .replace(/^作为(一个|一位)?/, '')
    .trim();
}

/** Content-word tokens (EN) or character bigrams (CJK) for overlap scoring. */
function tokensOf(text) {
  const cleaned = String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  if (cleaned === '') return [];
  if (CJK.test(cleaned)) {
    const chars = cleaned.replace(/\s+/g, '');
    if (chars.length < 2) return [chars];
    const bigrams = [];
    for (let i = 0; i + 1 < chars.length; i += 1) bigrams.push(chars.slice(i, i + 2));
    return [...new Set(bigrams)];
  }
  return [...new Set(cleaned.split(/\s+/).filter(w => w.length > 0 && !STOPWORDS_EN.has(w)))];
}

/**
 * Whether `benefit` merely restates `intent` in other words (the classic
 * "update my profile ... so that I can modify my profile" failure).
 * Two mechanical catches: high Jaccard similarity between the content words,
 * or one side's content words being ~half-covered by the other (near-paraphrase
 * containment, for both EN words and CJK bigrams). Semantic synonymy beyond
 * surface words is left to the reviewer prompts.
 */
export function isSynonymousRestatement(intent, benefit) {
  const a = tokensOf(intent);
  const b = tokensOf(benefit);
  if (a.length === 0 || b.length === 0) return false;
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared += 1;
  const jaccard = shared / (setA.size + setB.size - shared);
  const minSize = Math.min(setA.size, setB.size);
  const containment = shared / minSize;
  return jaccard >= 0.5 || (minSize >= 2 && containment >= 0.5);
}

/**
 * Validate one user story. Returns { ok, errors } — errors are actionable,
 * course-style ("role must name a specific real role, not 'user'").
 *
 * @param {object} story
 * @param {string} [story.subject] - card summary line.
 * @param {string} story.role - who raised the need (specific role).
 * @param {string} story.intent - the goal ("I want ...").
 * @param {string} story.benefit - the business value ("so that ...").
 * @param {string[]} story.acceptance_criteria - observable "Done" checks.
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateStory(story) {
  const errors = [];
  const subject = String(story?.subject ?? '').trim();
  const role = normalizeRole(story?.role);
  const intent = String(story?.intent ?? '').trim();
  const benefit = String(story?.benefit ?? '').trim();
  const criteria = Array.isArray(story?.acceptance_criteria) ? story.acceptance_criteria : [];

  if (subject === '') errors.push('subject is required — every story card carries a one-line summary');
  if (role === '') {
    errors.push('role is required — "As a [specific role]" (who would complain if the system disappeared tomorrow?)');
  } else if (GENERIC_ROLES.has(role.toLowerCase())) {
    errors.push(`role "${role}" is a generalized non-role; name the specific real user (e.g. "travel agent", "customer service officer"), never "user"`);
  }
  if (intent === '') errors.push('intent is required — "I want ..." states the goal, without locking in UI/technical implementation (Negotiable)');
  if (benefit === '') {
    errors.push('benefit is required — "so that ..." must state real business value (revenue up / cost or risk avoided / efficiency up)');
  } else if (intent !== '' && isSynonymousRestatement(intent, benefit)) {
    errors.push('benefit is a synonymous restatement of the goal — it must articulate value beyond repeating the intent in other words');
  }
  if (criteria.length === 0 || criteria.every(c => String(c).trim() === '')) {
    errors.push('acceptance_criteria are required (>= 1 non-empty) — a story with no confirmable "Done" is not Testable');
  }
  return { ok: errors.length === 0, errors };
}
