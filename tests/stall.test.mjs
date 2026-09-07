/**
 * Silent permanent stall — reported from a live session as
 * "消息进入队列但是刚好全部停止于是永久静默": a GO landed, every seat went idle
 * with mail pending, the subagents stopped *normally*, and the board never
 * moved again. No error, no API failure.
 *
 * The plugin cannot restart a conversation the harness has ended. These pin
 * the two things it can do: recognise the fixed point, and refuse to be quiet.
 */
import { stallDiagnosis, lastProgressAt, stallEscalation, goalLoopAdvice, STALL_AFTER_MS, WORKING_LEASE_MS } from '../lib/protocol/stall.js';
import { initialProtocolState } from '../lib/protocol/machine.js';

const T0 = 1_000_000;
const member = (name, status = 'idle', id = 'c-' + name) => ({ id, name, role: name, status, joinedAt: 1 });

function team(over = {}) {
  return {
    id: 'st1', name: 'ST', goal: 'g', mode: 'light', captainSessionId: 'cap1', createdAt: T0,
    members: [member('driver'), member('navigator')],
    tasks: [{ id: 't-1', subject: 's', status: 'in_progress', assignee: 'driver', dependencies: [], createdAt: T0, updatedAt: T0 }],
    taskSeq: 1, protocol: { ...initialProtocolState(), phase: 'CYCLING' }, ...over,
  };
}

export async function run(check) {
  /* ---- A: progress is derived from the board, never a second counter -- */
  const p = initialProtocolState();
  check(lastProgressAt(p) === 0, 'A an untouched board has no progress stamp');
  p.cycles.push({ id: 'c1', taskId: 't-1', openedAt: T0, green: { at: T0 + 500 } });
  check(lastProgressAt(p) === T0 + 500, 'A the newest timestamp anywhere on the board is the progress stamp');
  p.risks.push({ id: 'r-1', openedAt: T0 + 900 });
  check(lastProgressAt(p) === T0 + 900, 'A a risk ticket counts as movement too');

  /* ---- B: the fixed point, and everything that is NOT it -------------- */
  const quiet = { now: T0 + STALL_AFTER_MS + 1000 };
  const owed = { who: 'navigator', tool: 'pair_verify', cycleId: 'c1', why: 'x' };

  const working = team();
  working.members[0].status = 'working';
  working.members[0].activity = { lastActivityAt: quiet.now - 1000 };
  check(stallDiagnosis(working, { ...quiet, unread: { navigator: 3 }, obligation: owed }).stalled === false, 'B a seat still mid-turn is not a stall — it may yet act');
  working.members[0].activity.lastActivityAt = quiet.now - WORKING_LEASE_MS - 1;
  const expired = stallDiagnosis(working, { ...quiet, unread: { navigator: 3 }, obligation: owed });
  check(expired.stalled === true && expired.expiredWorking[0] === 'driver', 'B working is a renewable lease, not an infinite exemption from stall detection');

  const resting = team();
  check(stallDiagnosis(resting, { ...quiet, unread: { driver: 0, navigator: 0 } }).stalled === false, 'B everyone idle with nothing owed is rest, not a stall');

  const wrapping = team({ protocol: { ...initialProtocolState(), phase: 'RETRO' } });
  check(stallDiagnosis(wrapping, { ...quiet, unread: { navigator: 5 }, obligation: owed }).stalled === false, 'B a team in RETRO is not stalled, it is finishing');

  const recent = team();
  check(stallDiagnosis(recent, { now: T0 + 1000, unread: { navigator: 2 }, obligation: owed }).stalled === false, 'B a short quiet stretch is patience, not a stall');

  const stuck = team();
  const d = stallDiagnosis(stuck, { ...quiet, unread: { driver: 0, navigator: 4 }, obligation: owed });
  check(d.stalled === true, 'B THE reported regression: all idle + mail pending + nothing moved = the fixed point');
  check(d.waiting.includes('navigator') && d.idle.length === 2, 'B the diagnosis names who is idle and who has mail waiting');
  check(d.reason.includes('navigator') && /\d+s/.test(d.reason), 'B the reason is specific enough to act on, not "something seems stuck"');

  const owedNoMail = stallDiagnosis(team(), { ...quiet, unread: { driver: 0, navigator: 0 }, obligation: owed });
  check(owedNoMail.stalled === true, 'B an owed step with an empty mailbox still stalls — the message may have been consumed and dropped');

  /* ---- C: the escalation is an instruction, not a notification -------- */
  const text = stallEscalation('st1', d, '[PAIR:NEXT] navigator owes pair_verify(cycle_id=c1) — because');
  check(text.startsWith('[PAIR:STALL]'), 'C the escalation is a protocol message the captain can key off');
  check(text.includes('pair_verify(cycle_id=c1)'), 'C it carries the exact owed call, verbatim');
  check(text.includes('board outranks'), 'C it tells the captain to re-check the canonical board before forwarding an old call');
  check(!text.includes('create_goal') && !goalLoopAdvice('st1').includes('create_goal'), 'C goal polling is removed from the liveness path');

  /* ---- D: the honest boundary ----------------------------------------- */
  const advice = goalLoopAdvice('st1');
  check(advice.includes('board-event driven') && advice.includes('idle captain'), 'D pair_start states that real board events re-enter the captain');
  check(advice.includes('Do not create a goal') && advice.includes('external watchdog'), 'D goal stays an epic and schedule stays a host-death watchdog');
}

/**
 * The second failure mode, reported separately: a seat wakes, reads its mail,
 * and ends its turn without acting — because the line named it in the third
 * person and it read a status report about somebody else. The message is then
 * consumed, so the board freezes with an EMPTY mailbox and no seat believing it
 * holds the baton. Detection alone cannot fix that; the wording must.
 */
export async function runBaton(check) {
  const { obligationLine } = await import('../lib/protocol/obligation.js');
  const owed = { who: 'navigator', tool: 'pair_verify', cycleId: 'c-t-3-1-20', why: 'the verdict is computed' };

  const asOwner = obligationLine(owed, 'navigator');
  check(asOwner.startsWith('[PAIR:NEXT] YOU owe pair_verify(cycle_id=c-t-3-1-20)'), 'E the owed party is addressed in the second person, not asked to infer that "navigator" means itself');
  check(asOwner.includes('You are the last runner'), 'E it says plainly that the baton is held');
  check(asOwner.includes('nothing advances it until you make that call'), 'E and what happens if it stops: this task, forever');
  // Independent seats made the older wording ("nothing else on this board
  // moves") false, and a line the reader can disprove is a line it can ignore.
  check(asOwner.includes('Other seats may still have independent work'), 'E the stall warning is scoped to the task, so it stays true once other seats can run');
  check(asOwner.includes('Do not end your turn before it'), 'E the instruction targets the exact move that causes the stall');
  check(asOwner.includes('name who can'), 'E an honest out exists — stuck is fine, silent is not');

  const asBystander = obligationLine(owed, 'driver');
  check(asBystander.startsWith('[PAIR:NEXT] navigator owes'), 'E a bystander still gets the third-person form');
  check(!asBystander.includes('YOU owe'), 'E and is not told to act on someone else step');
  check(obligationLine(owed) === asBystander, 'E an unaddressed line (status, digest) reads as the neutral report it is');
  check(obligationLine(undefined, 'driver').includes('nothing is owed'), 'E an idle board says so to everyone');
}
