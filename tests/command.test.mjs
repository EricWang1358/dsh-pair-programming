/**
 * The `/pair` slash command, and the image attachments it used to refuse.
 *
 * The measured symptom: submitting `/pair` with a screenshot attached was
 * rejected by the composer with "/pair does not accept image attachments" —
 * a host-side gate, but one this plugin triggered by omitting `input.images`.
 * That closed the front door on exactly the work the protocol was hardened on:
 * the retrospective quoted throughout this codebase is a visual project that
 * shipped rain as white squares. A goal about what something LOOKS like has to
 * be able to show it.
 */
import { registerPairCommand, PAIR_COMMAND } from '../lib/command.js';

function harness() {
  const registered = [];
  const ctx = {
    effect: (fn) => fn(),
    commands: { register: (def) => { registered.push(def); return () => {}; } },
  };
  registerPairCommand(ctx);
  const def = registered[0];
  const followups = [];
  const agent = { followup: (message) => { followups.push(message); } };
  const invoke = (rawInput, attachments) => def.handler({
    commandId: 'c-1', agent, rawInput, attachments, signal: undefined,
  });
  return { def, invoke, followups };
}

const image = (id) => ({ type: 'image', attachment: { id } });

export async function run(check) {
  const h = harness();

  /* ---- the declaration the composer reads ------------------------------ */
  check(h.def.name === PAIR_COMMAND, 'the command registers under its own name');
  check(h.def.input?.images === true, 'the command declares that it takes images — without this the composer refuses the submission before the handler ever runs');
  check(typeof h.def.input?.hint === 'string' && h.def.input.hint.includes('goal'), 'and still states what the free-form input is');

  /* ---- images ride the activation line --------------------------------- */
  const ok = h.invoke(' make the rain in this screenshot render as streaks', [image('a'), image('b')]);
  check(ok.kind === 'success', 'a goal with attachments is accepted');
  check(h.followups.length === 1, 'and produces exactly one user follow-up');
  const content = h.followups[0].content;
  check(content[0].type === 'text' && content[0].text.startsWith(`/${PAIR_COMMAND}`), 'the activation line comes first, because the gesture boundary matches on it');
  check(content.filter(block => block.type === 'image').length === 2, 'both images are carried into the goal message');
  check(ok.text.includes('2 image(s)'), 'and the acknowledgment says the images went with it');

  /* ---- text still required, and a refusal must not cost the images ----- */
  const empty = h.invoke('   ', [image('a')]);
  check(empty.kind === 'error', 'an image with no goal text is refused — a screenshot is evidence, not a requirement');
  check(empty.text.includes('stay in the composer'), 'and the refusal says the images are retained, which is what returning an error guarantees');
  check(h.followups.length === 1, 'a refused submission produces no follow-up');

  /* ---- the ordinary path is unchanged ---------------------------------- */
  const plain = h.invoke(' add JWT refresh tokens');
  check(plain.kind === 'success' && h.followups.length === 2, 'a goal with no attachments still works');
  check(h.followups[1].content.length === 1, 'and carries only the activation line');
  check(!plain.text.includes('image'), 'with no mention of images that were never there');
  check(h.invoke('').kind === 'error', 'an empty goal is still a usage error');
}
