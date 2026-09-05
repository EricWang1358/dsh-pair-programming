/**
 * V5.4 — what a retrospective may put into the long-lived store.
 *
 * The failure is not a missing retro; it is a retro that works. Every session
 * produces keep/try items, every one is carried into the next session's
 * planning and into the board digest every recycled seat reads, and nothing
 * ever removes one. The store grows monotonically while each individual entry
 * looked reasonable on the day it was written.
 *
 * So there are two destinations: retro.md takes everything and costs nothing
 * later; the cross-session store is a prompt input, and an entry earns a place
 * there only by answering the counterfactual.
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  admitLessons, admissionError, normalizeLesson, overflowRefusal, lessonLine, DEFAULT_MAX_CARRIED,
} from '../lib/protocol/lessons.js';
import { boardDigest } from '../lib/protocol/digest.js';
import { registerLifecycleTools } from '../lib/tools/lifecycle.js';
import { initialProtocolState } from '../lib/protocol/machine.js';
import { createTeamDir, readTeam } from '../lib/state/store.js';

const good = {
  lesson: 'A Windows atomic rename fails when a reader holds the target open; retry with a backoff',
  counterfactual: 'without it the next Windows session rediscovers the EPERM by losing a board write, which cost half a session here',
  reuse_trigger: 'when adding any new durable write path under state/',
  evidence: ['lib/state/atomic.js', 'cycle c-t-3-1'],
};

function harness(root) {
  const defs = [];
  const ctx = {
    logger: { warn: () => {}, debug: () => {}, error: () => {} },
    tools: { register: (d) => { defs.push(d); } },
    agents: { get: () => undefined },
    subagents: { sendMessage: async () => 'm-1' },
    systemPrompt: { section: () => {} },
  };
  registerLifecycleTools(ctx, { stateDir: '.pair', tddMode: 'enforce', pairStyle: 'traditional', maxCarriedLessons: DEFAULT_MAX_CARRIED }, { selections: {}, scheduler: {} });
  return {
    tool: (n) => defs.find(d => d.name === n).execute,
    captain: { id: 'cap1', session: { header: { cwd: root }, append: () => {} } },
    stateRoot: join(root, '.pair'),
  };
}

function doneTeam() {
  return {
    id: 'les', name: 'LES', goal: 'g', mode: 'solo', tddMode: 'enforce', pairStyle: 'traditional',
    captainSessionId: 'cap1', createdAt: 1, updatedAt: 2,
    members: [], tasks: [{ id: 't-1', subject: 's', status: 'completed', dependencies: [], createdAt: 1, updatedAt: 2 }],
    taskSeq: 1, protocol: { ...initialProtocolState(), phase: 'DEVELOPING' }, evidenceStats: { cacheHits: 0, cacheMiss: 0 },
  };
}

async function fails(run) {
  try { await run(); return ''; } catch (error) { return String(error?.message ?? error); }
}

export async function run(check) {
  /* ---- the bar, question by question ----------------------------------- */
  check(admissionError(good) === undefined, 'an entry that answers every question is admitted');
  check(admissionError({ ...good, counterfactual: '' }).includes('what recurs'), 'no counterfactual: the entry must say what breaks if it is deleted');
  check(admissionError({ ...good, counterfactual: '' }).includes('retro archive'), 'and the refusal names the place it should go instead');
  check(admissionError({ ...good, reuse_trigger: '' }).includes('reuse trigger'), 'no trigger: a lesson nobody can be reminded of cannot be acted on');
  check(admissionError({ ...good, evidence: [] }).includes('evidence'), 'no evidence: a lesson with no anchor cannot be re-checked later');
  check(admissionError({ ...good, rederivable_from: 'lib/state/atomic.js and its tests' }).includes('re-derivable'), 're-derivable knowledge belongs in the repository, not in a second copy that goes stale on its own');
  check(admissionError('just a sentence').includes('counterfactual'), 'the bare-string shorthand cannot reach the store');
  check(admissionError({ lesson: '' }) === 'the entry has no text', 'an empty entry is rejected before anything else');

  /* ---- normalization tolerates the shapes a caller will actually send --- */
  check(normalizeLesson('x').lesson === 'x', 'a string is the lesson');
  check(normalizeLesson({ text: 'x' }).lesson === 'x' && normalizeLesson({ try: 'y' }).lesson === 'y', 'text/try alias onto lesson');
  check(normalizeLesson({ lesson: 'x', evidence: 'one' }).evidence.length === 1, 'a single evidence string is accepted as a list of one');
  check(normalizeLesson({ lesson: 'x', reuseTrigger: 'z' }).reuseTrigger === 'z', 'both snake_case and camelCase reach the same field');
  check(lessonLine({ lesson: 'x' }) === 'x' && lessonLine('y') === 'y', 'rendering handles both stored shapes');

  /* ---- nothing is lost; it is only sorted ------------------------------ */
  const mixed = admitLessons([good, 'a plain observation', { ...good, lesson: 'second real lesson' }]);
  check(mixed.carried.length === 2, 'entries that pass are carried');
  check(mixed.archived.length === 1 && mixed.archived[0].lesson === 'a plain observation', 'entries that fail are archived, not discarded');
  check(mixed.archived[0].why.includes('counterfactual'), 'and the archive records why each one was not carried');
  check(admitLessons([]).carried.length === 0, 'an empty proposal is not an error here');

  /* ---- the cap forces a ranking rather than accumulation --------------- */
  const four = admitLessons([good, { ...good, lesson: 'b' }, { ...good, lesson: 'c' }, { ...good, lesson: 'd' }], { max: 3 });
  check(four.carried.length === 3 && four.overflow.length === 1, 'past the cap, the surplus is reported rather than silently dropped');
  check(overflowRefusal(four, 3).includes('Rank them'), 'the refusal asks the captain to rank, because which three matter is a judgement');
  check(overflowRefusal(four, 3).includes('retro.md, which loses nothing'), 'and says plainly that nothing is thrown away');
  check(admitLessons([good, { ...good, lesson: 'b' }], { max: 0 }).carried.length === 0, 'a zero cap carries nothing at all');

  /* ---- end to end through pair_retro ----------------------------------- */
  const root = await mkdtemp(join(tmpdir(), 'pair-les-'));
  try {
    const h = harness(root);
    await createTeamDir(h.stateRoot, doneTeam());

    const overflowed = await fails(() => h.tool('pair_retro')({
      keep: ['oracle-first held'],
      try: [good, { ...good, lesson: 'b' }, { ...good, lesson: 'c' }, { ...good, lesson: 'd' }],
    }, { agent: h.captain }));
    check(overflowed.includes('RETRO_CARRY_OVERFLOW'), 'a retro proposing more than the cap is refused with a named code');

    const result = await h.tool('pair_retro')({
      keep: ['oracle-first held'],
      try: [good, 'we should probably tidy the logs'],
      notes: 'two cycles were rejected for scope',
    }, { agent: h.captain });
    check(result.try_count === 1 && result.carried.length === 1, 'only the entry that answered the counterfactual is carried');
    check(result.archived.length === 1 && result.archived[0].why.includes('counterfactual'), 'the tool reports what it archived and why');
    check(result.carry_note.includes('Everything is recorded'), 'and says explicitly that nothing was thrown away');

    const retro = await readFile(result.retro_file, 'utf8');
    check(retro.includes('carried into future sessions'), 'retro.md separates the two destinations');
    check(retro.includes('if deleted:') && retro.includes('recall when:'), 'a carried entry is archived with the answers that admitted it');
    check(retro.includes('Archived here only'), 'and the rejected entry is still written down');
    check(retro.includes('we should probably tidy the logs'), 'nothing a captain wrote is lost from the archive');

    const after = await readTeam(h.stateRoot, 'les');
    check(after.processLessons.try.length === 1, 'only carried entries reach the cross-session record');
    check(after.processLessons.try[0].counterfactual !== undefined, 'and they keep the answers, so a later session can judge whether they still hold');
    const stored = JSON.parse(await readFile(join(h.stateRoot, 'lessons.json'), 'utf8'));
    check(stored.try.length === 1 && stored.keep.length === 1, 'the inherited file carries the same one entry');

    const digest = boardDigest({ ...after, processLessons: after.processLessons });
    check(digest.includes('atomic rename') || digest.includes('Carried lessons'), 'the digest renders a structured lesson as its text, not as [object Object]');
    check(!digest.includes('[object'), 'a recycled seat never receives a stringified object');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
