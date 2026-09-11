/**
 * Which CE skill covers a protocol moment - and when to say nothing at all.
 *
 * L2: the core owns the review obligation, the adapter provides the skill. Before this,
 * the plugin catalogued skills for the model and never connected one to the moment a seat
 * is actually owed something, so a seat chose (or forgot) on its own.
 *
 * Two rules, both learned the hard way:
 *  - the mapping is grounded in each skill's own body, never in its name (the catalog
 *    described ce-proof as evidence review until #81; a name is not a capability);
 *  - a moment with no honest match names NOTHING. A plausible-looking skill is worse than
 *    silence, because the seat will act on it.
 *
 * A skill is only named when the current lane actually serves it to the model: in the
 * captain lane the constructive skills are user gestures, and telling a seat to invoke one
 * would be instructions it cannot follow.
 *
 * @module dsh-pair-programming/integrations/ce-moments
 */
import { entriesForLane } from './ce-catalog.js';

/** Protocol moment -> the CE skill whose own description covers that moment. */
const MOMENTS = [
  { call: 'pair_review', skill: 'ce-code-review', why: 'review the candidate into findings with cited evidence before the GO/NO_GO' },
  { call: 'pair_arbitrate', skill: 'ce-pov', why: 'a ruling is a decisive, project-grounded position' },
  { call: 'pair_retro', skill: 'ce-compound', why: 'retrospective capture: one learning, only if it survives a counterfactual' },
  { call: 'pair_red', skill: 'ce-debug', why: 'a red step is a fault to localise before it is fixed' },
  { call: 'pair_refactor', skill: 'ce-simplify-code', why: 'simplify settled, recently changed code while preserving behaviour' },
  { call: 'pair_propose', skill: 'ce-ideate', why: 'rank candidate approaches without deciding' },
  { call: 'pair_backlog', skill: 'ce-brainstorm', why: 'press a vague observation into executable requirements' },
];

/** The moment entry, only when `lane` serves that skill to the model. */
export function ceMomentSkill(lane, call) {
  const entry = MOMENTS.find(moment => moment.call === call);
  if (entry === undefined) return undefined;
  const served = entriesForLane(lane).some(item => item.name === entry.skill && item.surface === 'model');
  return served ? entry : undefined;
}

/** One board line for an owed call, or undefined when there is nothing honest to say. */
export function ceMomentLine(lane, call) {
  const entry = ceMomentSkill(lane, call);
  return entry === undefined ? undefined : `Skill for ${call}: ${entry.skill} - ${entry.why}.`;
}

/** The whole mapping, for tests and for the audit that keeps it grounded. */
export function ceMomentCoverage() {
  return MOMENTS.map(moment => `${moment.call} -> ${moment.skill}`);
}