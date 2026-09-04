/**
 * What a retrospective is allowed to put into the long-lived store.
 *
 * The failure this exists for is not a missing retro — it is a retro that
 * works. Every session ends with keep/try items, every one of them is carried
 * into the next session's planning and into the board digest every recycled
 * seat reads, and nothing ever removes one. The store grows monotonically, and
 * the ratio of "things a future session actually needed" to "things it now
 * pays for on every step" falls without anyone noticing, because each
 * individual entry looked reasonable on the day it was written.
 *
 * So there are two destinations, not one. `retro.md` is the session archive:
 * it takes everything, costs nothing later, and is what you read when you want
 * to know what happened. The cross-session store is a prompt input, and an
 * entry earns a place there only by answering the question that makes a lesson
 * worth carrying:
 *
 *   - counterfactual: what recurs, or has to be re-investigated, if this entry
 *     is deleted? "It is useful context" is not an answer.
 *   - reuse trigger: what would a future session be doing when it needs this?
 *     A lesson nobody can be reminded of at the right moment is decoration.
 *   - evidence: the cycle, risk, file, or command this came from. A lesson
 *     with no anchor cannot be checked later, and a stale one cannot be found.
 *   - not re-derivable: if the current code, tests, types or docs already say
 *     it, the repository is the better home and the entry is redundant the
 *     moment it is written.
 *
 * An entry that fails the bar is not rejected — it is archived. Nothing is
 * lost; it just stops being something every future session pays for.
 *
 * Pure logic, unit-testable.
 *
 * @module dsh-pair-programming/protocol/lessons
 */

/** Ranked entries carried across sessions, unless configured otherwise. */
export const DEFAULT_MAX_CARRIED = 3;

/** Normalize one `try` item: a bare string is the archive-only shorthand. */
export function normalizeLesson(raw) {
  if (typeof raw === 'string') return { lesson: raw.trim() };
  if (raw === null || typeof raw !== 'object') return { lesson: '' };
  const text = (value) => String(value ?? '').trim();
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence.map(item => text(item)).filter(Boolean)
    : text(raw.evidence) === '' ? [] : [text(raw.evidence)];
  return {
    lesson: text(raw.lesson ?? raw.text ?? raw.try),
    counterfactual: text(raw.counterfactual),
    reuseTrigger: text(raw.reuse_trigger ?? raw.reuseTrigger),
    evidence,
    rederivableFrom: text(raw.rederivable_from ?? raw.rederivableFrom),
  };
}

/**
 * Why one entry may not enter the cross-session store, or undefined when it
 * may. The refusals are written to be actionable: each names the missing
 * question rather than the missing field.
 */
export function admissionError(entry) {
  const item = normalizeLesson(entry);
  if (item.lesson === '') return 'the entry has no text';
  if (!item.counterfactual) {
    return 'no counterfactual: say what recurs, or what has to be re-investigated, if this entry is deleted. If nothing does, it belongs in the retro archive rather than in every future session';
  }
  if (!item.reuseTrigger) {
    return 'no reuse trigger: say what a future session would be doing when it needs this. A lesson nobody can be reminded of at the right moment cannot be acted on';
  }
  if (item.evidence.length === 0) {
    return 'no evidence: name the cycle, risk, file, or command this came from, so a later session can check whether it still holds';
  }
  if (item.rederivableFrom) {
    return `re-derivable from ${item.rederivableFrom}: the repository already carries this, so the entry would be a second copy that can go stale independently — keep it in the retro archive`;
  }
  return undefined;
}

/**
 * Split proposed entries into what is carried and what is archived.
 *
 * @param {Array<string|object>} entries
 * @param {{max?:number}} [opts]
 * @returns {{carried:object[], archived:{lesson:string, why:string}[], overflow:object[]}}
 */
export function admitLessons(entries, opts = {}) {
  const max = Number.isInteger(opts.max) && opts.max >= 0 ? opts.max : DEFAULT_MAX_CARRIED;
  const carried = [];
  const archived = [];
  const overflow = [];
  for (const raw of entries ?? []) {
    const item = normalizeLesson(raw);
    if (item.lesson === '') continue;
    const why = admissionError(raw);
    if (why !== undefined) {
      archived.push({ lesson: item.lesson, why });
      continue;
    }
    if (carried.length >= max) {
      overflow.push(item);
      continue;
    }
    carried.push(item);
  }
  return { carried, archived, overflow };
}

/**
 * The refusal for a retro that proposed more admissible entries than the cap.
 *
 * Deliberately a refusal rather than a silent truncation: which three lessons
 * matter is a judgement the captain has to make, and a tool that quietly drops
 * the fourth would be making it invisibly.
 */
export function overflowRefusal(result, max) {
  const names = [...result.carried, ...result.overflow].map(item => `"${item.lesson.slice(0, 60)}"`);
  return `${names.length} entries pass the bar but at most ${max} are carried across sessions — every carried entry is re-read by every future session and every recycled seat. `
    + `Rank them and keep the ${max} that would actually change what a future session does; the rest stay in retro.md, which loses nothing. Candidates: ${names.join(', ')}`;
}

/** One line per carried entry, for retro.md and the board digest. */
export function lessonLine(item) {
  const text = typeof item === 'string' ? item : item?.lesson;
  return String(text ?? '');
}
