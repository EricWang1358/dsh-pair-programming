/**
 * Whose turn is it, and what do they owe? (v3.1)
 *
 * Why this exists — measured, not guessed. Two full v3 sessions were replayed:
 *
 *   session A: 23 captain `send_message` calls, one per protocol step, each a
 *              prose instruction ("请 Navigator pair_verify", "请 Driver gate").
 *   session B: 151 captain `send_message` calls — and across the entire run,
 *              28 `pair_propose`, 35 `pair_green`, and **zero `pair_verify`**.
 *              The review seat took 2 turns all session; the Driver took 50.
 *
 * The mechanisms were all present and working. What was missing is that the
 * protocol never told anyone whose move it was, so the captain became the
 * scheduler — hand-relaying every handoff at full context price — and when the
 * captain missed a beat, the review step simply never happened and nobody
 * noticed. A loop that depends on someone remembering to nudge it is not a
 * protocol; it is a habit.
 *
 * The board already knows the answer: cycle steps and task oracle states
 * determine the current calls owed by each seat. This module derives them, so the
 * delivery layer can state it and `pair_propose` can refuse to run ahead of it.
 *
 * Pure logic, unit-testable.
 *
 * @module dsh-pair-programming/protocol/obligation
 */
import { openDisclosures } from './disclosure.js';
import { isDispatchClosed } from './machine.js';

const unfinished = cycle => cycle.step !== 'CLOSED'
  && cycle.verify?.verdict !== 'accept' && cycle.verify?.verdict !== 'checkpoint';

/** The oldest unfinished cycle remains open through REJECT and its repair. */
export function unverifiedCycle(protocol, taskId) {
  return unverifiedCycles(protocol).find(cycle => cycle.taskId === taskId);
}

/** An appended cycle cannot supersede old debt without an explicit closure. */
export function unverifiedCycles(protocol) {
  return (protocol?.cycles ?? []).filter(unfinished);
}

const liveTask = task => task.status === 'claimed' || task.status === 'in_progress';
const activeMember = member => member.status !== 'removed' && member.id !== '';

function seatName(team, role) {
  if (role === 'captain' || (team?.mode === 'solo' && (role === 'driver' || role === 'navigator'))) return 'captain';
  return team?.members?.find(member => member.role === role && activeMember(member))?.name;
}

function captainDecision(taskId, cycleId, why) {
  return { who: 'captain', tool: 'pair_arbitrate', taskId, ...(cycleId === undefined ? {} : { cycleId }), why };
}

function forSeat(team, role, obligation) {
  const who = seatName(team, role);
  return who === undefined
    ? captainDecision(obligation.taskId, obligation.cycleId, `the ${role} seat is absent; restore its ownership before ${obligation.tool} can proceed`)
    : { who, ...obligation };
}

function cycleObligation(team, task, cycle) {
  const owed = (role, tool, why) => forSeat(team, role, { tool, cycleId: cycle.id, taskId: task.id, why });
  // A seal replacement has no legal repair edge in the current flow API:
  // pair_verify refuses the mismatch and pair_propose cannot hide the debt.
  if (cycle.oracleSha !== undefined && task.oracle?.sha !== cycle.oracleSha) {
    return captainDecision(task.id, cycle.id, 'this open cycle and the task carry different oracle seals; restore the original seal or rule on an explicit cycle repair before continuing');
  }
  if (team.mode === 'solo' && cycle.oracleSha === undefined) {
    return captainDecision(task.id, cycle.id, 'solo verification cannot close an oracle-free cycle; rule on its repair under a SPEC-authored oracle');
  }
  switch (cycle.step) {
    case 'PROPOSED':
      return owed('navigator', 'pair_review', 'review the current proposal and recorded feedback; issue GO on this same cycle only when its scope is acceptable');
    case 'GO':
      if (cycle.oracleSha !== undefined) return owed('driver', 'pair_green', 'the frozen oracle is RED; repair any rejected implementation, then report the minimal passing change on this same cycle');
      if (cycle.trivial || (cycle.tddMode ?? team.tddMode) !== 'enforce') return owed('driver', 'pair_report', 'implement the approved legacy or trivial step and report its evidence');
      return owed('driver', 'pair_red', 'record the failing test for the approved step, including any rejected case, before implementing its repair');
    case 'RED':
      return owed('driver', 'pair_green', 'the failing test is recorded; make it pass minimally');
    case 'GREEN':
      if (cycle.oracleSha === undefined) return owed('driver', 'pair_refactor', 'clean up under the green tests and report the legacy TDD cycle before independent verification');
      return owed('navigator', 'pair_verify', 'read the current implementation and recorded rejection; recompute the frozen digest and command for a fresh verdict that cannot be asserted');
    case 'IMPLEMENTED':
    case 'REFACTOR':
      return owed('navigator', 'pair_verify', 'the current implementation is reported and awaits a fresh independent verdict');
    default:
      return captainDecision(task.id, cycle.id, `the cycle is unfinished at unsupported step ${cycle.step}; rule on its repair instead of starting another cycle`);
  }
}

/**
 * Ordered current debts: committed cycles, other live tasks, ready claims and
 * future oracle preparation, then disclosures. All task ordering is durable.
 * No second canonical task is claimed while the builder owns unfinished work.
 * Oracle preparation uses its task's reserved files without claiming the task.
 */
export function obligationFrontier(team, opts = {}) {
  const phase = team?.protocol?.phase;
  if (phase === 'DONE' || phase === 'ABORTED') return [];
  const tasks = team?.tasks ?? [];
  const cycles = team?.protocol?.cycles ?? [];
  const latest = new Map(cycles.map(cycle => [cycle.taskId, cycle]));
  const openTaskIds = new Set(cycles.filter(unfinished).map(cycle => cycle.taskId));
  const live = tasks.filter(liveTask);
  const builder = seatName(team, 'driver');
  const canonical = task => task.assignee === undefined || task.assignee === builder;
  const currentCanonical = live.find(task => canonical(task) && cycles.some(cycle => cycle.taskId === task.id))
    ?? live.find(canonical);
  const author = team?.mode === 'solo' ? 'spec' : 'navigator';
  const needsOracle = task => task.oracle === undefined
    && (team?.mode === 'solo' || (task.trivial !== true && (opts.oracleFirst ?? team?.oracleFirst) !== false));
  const oracleOwed = task => forSeat(team, author, {
    tool: 'pair_oracle', taskId: task.id,
    why: 'prepare and freeze the acceptance oracle from this task specification in its reserved oracle files; do not claim the implementation task',
  });
  const out = [];
  if (!isDispatchClosed(phase)) {
    for (const cycle of cycles.filter(unfinished)) {
      const task = live.find(candidate => candidate.id === cycle.taskId);
      if (task !== undefined) out.push(cycleObligation(team, task, cycle));
    }
    for (const task of live) {
      const cycle = latest.get(task.id);
      if (openTaskIds.has(task.id)) continue;
      if (!canonical(task)) {
        const owner = team?.members?.find(member => member.name === task.assignee && activeMember(member));
        out.push(owner === undefined
          ? captainDecision(task.id, undefined, 'the assigned task owner is absent; restore ownership before continuing')
          : { who: owner.name, tool: 'pair_task_update', taskId: task.id, why: 'finish the explicitly assigned work and record its output with the current attempt_id; obtain the task gate before marking it completed' });
      } else if (cycle?.verify?.verdict === 'accept') {
        out.push(forSeat(team, 'driver', { tool: 'pair_gate_check', taskId: task.id, why: 'the latest cycle is accepted; run the task gate and complete it with the returned gate_pass_id' }));
      } else if (cycle?.verify?.verdict === 'checkpoint') {
        out.push(forSeat(team, 'driver', {
          tool: 'pair_propose', taskId: task.id,
          why: `the latest cycle is a checkpoint, not final acceptance; propose the next increment, or ask the verifier to promote ${cycle.id} with pair_verify(stage="final") when the full task is ready`,
        }));
      } else if (needsOracle(task)) out.push(oracleOwed(task));
      else out.push(forSeat(team, 'driver', { tool: 'pair_propose', taskId: task.id, why: 'open a small cycle; if using an oracle-free exemption, supply its no_oracle_reason again unless the task is trivial or oracle-first is disabled' }));
    }
    const ready = tasks.filter(task => task.status === 'pending' && task.handoffId === undefined
      && (task.dependencies ?? []).every(id => tasks.find(candidate => candidate.id === id)?.status === 'completed'));
    if (!live.some(canonical)) {
      const task = ready.find(canonical);
      if (task !== undefined) out.push(forSeat(team, 'driver', { tool: 'pair_task_claim', taskId: task.id, why: 'this task is unclaimed and every dependency is completed' }));
    }
    for (const task of ready.filter(canonical)) {
      if (needsOracle(task) && latest.get(task.id) === undefined) out.push(oracleOwed(task));
    }
    // The write API is confined to reserved oracle files. Freezing executes a
    // command against the shared candidate, so future work stays draft-only
    // until the current canonical task is terminal. There is no durable draft
    // marker in the existing API: unchanged-debt dedupe bounds its notification.
    for (const obligation of out) {
      if (obligation.tool === 'pair_oracle' && currentCanonical !== undefined && currentCanonical.id !== obligation.taskId) {
        obligation.tool = 'pair_oracle_write';
        obligation.preparationOnly = true;
        obligation.why = 'prepare draft acceptance files in this task reserved oracle directory without claiming it; once the draft is written, wait for the current canonical task to finish before freezing or executing its oracle command';
      }
    }
  }
  for (const disclosure of openDisclosures(team)) {
    out.push({ who: 'captain', tool: 'pair_arbitrate', disclosureRef: disclosure.ref,
      why: `the board declared a ${disclosure.kind} and nobody has ruled on it; close it with evidence before claiming success` });
  }
  return out;
}

/** Compatible primary projection; pass a member name to select its own debt. */
export function nextObligation(team, recipient, opts = {}) {
  const frontier = obligationFrontier(team, opts);
  return recipient === undefined ? frontier[0] : frontier.find(obligation => obligation.who === recipient);
}

/**
 * The one-line `[PAIR:NEXT]` marker appended to every protocol delivery and
 * shown by pair_status. Deterministic text: it is derived from the board, so
 * it can never disagree with it the way a captain's prose instruction can.
 */
export function obligationLine(obligation, recipient) {
  if (obligation === undefined) return '[PAIR:NEXT] nothing is owed — no task is in flight.';
  const target = obligation.tool === 'pair_arbitrate' && obligation.disclosureRef === undefined
    ? `conflict_ref=${obligation.cycleId ?? obligation.taskId ?? 'plan'}`
    : obligation.cycleId !== undefined
    ? `cycle_id=${obligation.cycleId}`
    : obligation.disclosureRef !== undefined
      ? `closes_disclosure=${obligation.disclosureRef}`
      : `task_id=${obligation.taskId}`;
  const call = `${obligation.tool}(${target})`;
  // Third person is an inference the reader has to make, and a seat deep in a
  // long context makes it wrong: it reads "navigator owes pair_review" as a
  // status report about somebody else and ends its turn. Nothing is pending
  // afterwards — the message was consumed — so the board freezes with an empty
  // mailbox and no seat believing it holds the baton. When the reader IS the
  // owed party, say so in the second person and say what happens if it stops.
  if (recipient !== undefined && recipient === obligation.who) {
    return `[PAIR:NEXT] YOU owe ${call} — ${obligation.why}. This is your next owed action; other seats may have independent work. Do not end your turn before it; if you cannot make it, say why and name who can.`;
  }
  return `[PAIR:NEXT] ${obligation.who} owes ${call} — ${obligation.why}`;
}

/**
 * Why a Driver may not open another cycle yet.
 *
 * Back-pressure is the structural half of the same finding: in the replayed
 * session the Driver opened 28 cycles and greened 35 times while zero verdicts
 * existed. Nothing in v3 stopped it, because verification gated *completion*
 * and never *continuation*. One unverified cycle per task is the whole rule.
 *
 * @returns {string|undefined} the refusal, or undefined when a new cycle is allowed.
 */
export function backPressure(protocol, taskId) {
  const open = unverifiedCycle(protocol, taskId);
  if (open === undefined) return undefined;
  return `cycle ${open.id} is still at step ${open.step} with no verdict that closes it — finish it before opening another. `
    + `A second cycle here would stack unreviewed work: ${open.step === 'PROPOSED' ? 'the reviewer must issue pair_review on the existing proposal' : 'follow the current cycle step to a fresh verification'} on ${open.id}, `
    + 'and a REJECT rewinds that cycle rather than starting a new one.';
}
