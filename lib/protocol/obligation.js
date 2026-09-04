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
 * The board already knows the answer: a cycle's step plus the task's oracle
 * state determine exactly one next call. This module derives it, so the
 * delivery layer can state it and `pair_propose` can refuse to run ahead of it.
 *
 * Pure logic, unit-testable.
 *
 * @module dsh-pair-programming/protocol/obligation
 */
import { openDisclosures } from './disclosure.js';

/** A cycle that has been opened but carries no verdict yet. */
export function unverifiedCycle(protocol, taskId) {
  return (protocol?.cycles ?? []).find(c => c.taskId === taskId && c.verify === undefined);
}

/** Every cycle across the team still awaiting a verdict, oldest first. */
export function unverifiedCycles(protocol) {
  return (protocol?.cycles ?? []).filter(c => c.verify === undefined);
}

/**
 * The single next protocol call the board is waiting on, or undefined when the
 * team is genuinely idle (no task in flight).
 *
 * @param {object} team - the durable team record.
 * @returns {{who:string, tool:string, cycleId?:string, taskId?:string, why:string}|undefined}
 */
export function nextObligation(team) {
  const protocol = team?.protocol ?? {};
  const cycles = protocol.cycles ?? [];
  const cycle = cycles[cycles.length - 1];
  const taskOf = (id) => (team?.tasks ?? []).find(t => t.id === id);

  // An open cycle outranks everything: it is work already committed to.
  if (cycle !== undefined && cycle.verify === undefined) {
    const task = taskOf(cycle.taskId);
    switch (cycle.step) {
      case 'PROPOSED':
        return {
          who: 'navigator', tool: 'pair_review', cycleId: cycle.id, taskId: cycle.taskId,
          why: 'the proposal is larger than the small-step threshold, so it waits for an explicit GO or a NO_GO asking to split it',
        };
      case 'GO':
        return {
          who: 'driver', tool: cycle.oracleSha === undefined ? 'pair_red' : 'pair_green', cycleId: cycle.id, taskId: cycle.taskId,
          why: cycle.oracleSha === undefined
            ? 'no oracle is frozen for this task, so this cycle still owes its own failing test first'
            : 'the frozen oracle is this cycle RED — implement the minimal change that turns it green, and report diff_summary/test_results in the same step',
        };
      case 'RED':
        return { who: 'driver', tool: 'pair_green', cycleId: cycle.id, taskId: cycle.taskId, why: 'the failing test is recorded; make it pass minimally' };
      case 'GREEN':
        return {
          who: 'navigator', tool: 'pair_verify', cycleId: cycle.id, taskId: cycle.taskId,
          why: task?.oracle === undefined
            ? 'the implementation is reported and awaits an independent verdict'
            : 'the verdict is computed by recomputing the frozen digest and re-running the frozen command — it cannot be asserted, and nothing else may start until it exists',
        };
      case 'IMPLEMENTED':
      case 'REFACTOR':
        return { who: 'navigator', tool: 'pair_verify', cycleId: cycle.id, taskId: cycle.taskId, why: 'the cycle is reported and awaits a verdict' };
      default:
        break;
    }
  }

  // No open cycle: the next move belongs to whoever can start one.
  const live = (team?.tasks ?? []).find(t => t.status === 'claimed' || t.status === 'in_progress');
  if (live !== undefined) {
    if (live.oracle === undefined) {
      return {
        who: 'navigator', tool: 'pair_oracle', taskId: live.id,
        why: 'the task has no frozen acceptance oracle — SPEC-FORK comes before any approach exists, and pair_propose refuses without one',
      };
    }
    const accepted = cycles.some(c => c.taskId === live.id && c.verify?.verdict === 'accept');
    if (accepted) {
      return { who: 'driver', tool: 'pair_gate_check', taskId: live.id, why: 'a cycle is accepted — run the gate (it replays the frozen oracle) and complete the task with its gate_pass_id' };
    }
    return { who: 'driver', tool: 'pair_propose', taskId: live.id, why: 'the oracle is frozen; open a small cycle against it' };
  }

  const pending = (team?.tasks ?? []).find(t => t.status === 'pending');
  if (pending !== undefined) {
    return { who: 'driver', tool: 'pair_task_claim', taskId: pending.id, why: 'a ready task is unclaimed' };
  }
  // Once the work itself is terminal, every declared blind spot has one
  // explicit owner: the captain rules it fixed, accepted, or deferred. This
  // is the missing downstream edge behind "disclosure != treatment".
  const disclosure = openDisclosures(team)[0];
  if (disclosure !== undefined) {
    return {
      who: 'captain', tool: 'pair_arbitrate', disclosureRef: disclosure.ref,
      why: `the board declared a ${disclosure.kind} and nobody has ruled on it — close it with evidence before claiming success`,
    };
  }
  return undefined;
}

/**
 * The one-line `[PAIR:NEXT]` marker appended to every protocol delivery and
 * shown by pair_status. Deterministic text: it is derived from the board, so
 * it can never disagree with it the way a captain's prose instruction can.
 */
export function obligationLine(obligation, recipient) {
  if (obligation === undefined) return '[PAIR:NEXT] nothing is owed — no task is in flight.';
  const target = obligation.cycleId !== undefined
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
    return `[PAIR:NEXT] YOU owe ${call} — ${obligation.why}. You are the last runner: nothing else on this board moves until you make that call, and no timer or teammate will make it for you. Do not end your turn before it; if you cannot make it, say why and name who can.`;
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
  return `cycle ${open.id} is still at step ${open.step} with no verdict — finish it before opening another. `
    + `A second cycle here would stack unreviewed work: the Navigator owes ${open.step === 'PROPOSED' ? 'pair_review' : 'pair_verify'} on ${open.id}, `
    + 'and a REJECT rewinds that cycle rather than starting a new one.';
}
