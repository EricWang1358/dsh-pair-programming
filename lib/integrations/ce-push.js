/**
 * The one push case: a phase-bound skill body handed to a seat at spawn,
 * instead of a catalog entry it browses.
 *
 * Why push at all when the pull catalog exists. A member seat is respawned per
 * Pair Cycle from a board digest, so anything it can browse is paid for on
 * every step of every cycle it lives through. For a skill that is only ever
 * useful in ONE step of ONE role — simplification advice while the Driver is
 * refactoring — a catalog entry is the wrong shape: it charges every cycle for
 * something that applies to a few of them, and it invites the seat to load it
 * at the wrong moment.
 *
 * Why exactly one case. Push is deliberately narrow, because it is the
 * expensive delivery: the body rides the persona, so the seat pays for it
 * whether or not it uses it. Everything else stays on the pull path where the
 * cost is one short routing line and the seat decides.
 *
 * The budget is the honest part. A CE body is 6–8 KB; the persona is a prefix
 * that is re-sent for the seat's whole life. So the pushed text is capped, and
 * the cap says out loud that it was cut and where the rest is.
 *
 * @module dsh-pair-programming/integrations/ce-push
 */
import { entriesForLane } from './ce-catalog.js';

/** Characters of skill body one push may add to a persona. */
export const CE_PUSH_BUDGET = 2400;

/**
 * Which skill, if any, this seat should be handed at spawn.
 *
 * Only lane `full` pushes at all: `advisory` is the pull-only lane, and the
 * difference between them is exactly this. Only the Driver. And only once the
 * task's behaviour is already green, because that is the moment "could this be
 * simpler" is a question about shape rather than about scope.
 *
 * The original trigger was `cycleStep === 'REFACTOR'`, and it could never fire
 * for three independent reasons, none of which a unit test on this function
 * could see:
 *   1. an oracle cycle folds REFACTOR into GREEN (flow.js refuses a separate
 *      refactor round), and `oracleFirst` is the default;
 *   2. a respawn happens only after a cycle was ACCEPTED, so the last cycle
 *      always carries a verdict and no step is "current" at that moment;
 *   3. the push path resolved the lane with an empty cwd, which reads as
 *      "no team live" and served the solo set instead.
 * The phase below is derived from the board at the respawn boundary itself,
 * which is the only moment a persona can be composed.
 */
export function pushTargetFor({ lane, role, phase } = {}) {
  if (lane !== 'full') return undefined;
  if (role !== 'driver') return undefined;
  if (phase !== 'post-green') return undefined;
  return entriesForLane(lane).some(entry => entry.name === 'ce-simplify-code') ? 'ce-simplify-code' : undefined;
}

/**
 * Where the live task stands, as the push cares about it.
 *
 * `pre-green` — nothing has been accepted yet; simplification advice would be
 *   advice about work that does not exist.
 * `post-green` — at least one cycle was accepted and the task is still open:
 *   behaviour holds, more increments are coming, and shape is now the question.
 * `undefined` — no task in flight.
 */
export function pushPhaseOf(team) {
  const task = (team?.tasks ?? []).find(t => t.status === 'claimed' || t.status === 'in_progress');
  if (task === undefined) return undefined;
  const accepted = (team?.protocol?.cycles ?? [])
    .some(c => c.taskId === task.id && c.verify?.verdict === 'accept');
  return accepted ? 'post-green' : 'pre-green';
}

/** The cycle step a team is currently in, or undefined when no cycle is open. */
export function currentStepOf(team) {
  const cycles = team?.protocol?.cycles ?? [];
  const cycle = cycles[cycles.length - 1];
  return cycle !== undefined && cycle.verify === undefined ? cycle.step : undefined;
}

/**
 * Build the persona appendix for one seat.
 *
 * Bodies are cached by `(skill, CE commit)` for the life of the process: the
 * same body is otherwise re-read and re-trimmed on every cycle respawn, and a
 * changed commit is exactly when the cache must miss.
 *
 * @param {{ lane:string, role:string, team:object, load:Function, probe?:object, cache?:Map }} deps
 *   `load(name)` returns the served skill definition (boundary preamble
 *   included) or undefined.
 * @returns {Promise<string>} the appendix, or '' when nothing is pushed.
 */
export async function cePushAppendix(deps) {
  const target = pushTargetFor({ lane: deps.lane, role: deps.role, phase: pushPhaseOf(deps.team) });
  if (target === undefined) return '';
  const cache = deps.cache;
  const key = `${target}@${deps.probe?.commitSha ?? 'no-commit'}`;
  let body = cache?.get(key);
  if (body === undefined) {
    let definition;
    try {
      definition = await deps.load(target);
    } catch {
      return '';
    }
    if (definition?.content === undefined) return '';
    const text = String(definition.content);
    body = text.length <= CE_PUSH_BUDGET
      ? text
      : `${text.slice(0, CE_PUSH_BUDGET)}\n\n[trimmed to ${CE_PUSH_BUDGET} characters — load the full ${target} skill if you need the rest]`;
    cache?.set(key, body);
  }
  return [
    '',
    `## Simplification aid (${target}, advisory)`,
    'A cycle on this task has already been accepted, so the behaviour holds and the oracle is sealed: this is advice about shape, not about scope. Anything it suggests that changes behaviour belongs in a new proposal with its own verdict, never as clean-up.',
    '',
    body,
  ].join('\n');
}
