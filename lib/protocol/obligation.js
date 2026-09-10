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
import { claimEligibility, driverForTask } from '../runtime/parallel-tasks.js';
import { gateStateFingerprint } from './gate.js';
import { rankReadyTasks } from './product.js';

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

/** Future oracle files are candidate dependencies too. Once the current task
 * has produced a candidate, reserve that workspace until the task is terminal,
 * including checkpoints or rejected repairs. Its own author can still repair
 * an oracle through the existing current-task rules. */
export function oraclePreparationWindow(team, taskId) {
  if (team.parallel) {
    const task = team.tasks.find(item => item.id === taskId);
    return { currentTaskId: taskId, future: !task?.workspace || !liveTask(task), paused: !task?.workspace || !liveTask(task) };
  }
  const builder = seatName(team, 'driver');
  const live = (team?.tasks ?? []).filter(task => liveTask(task) && (task.assignee === undefined || task.assignee === builder));
  const cycles = team?.protocol?.cycles ?? [];
  const current = live.find(task => cycles.some(cycle => cycle.taskId === task.id)) ?? live[0];
  const future = current !== undefined && current.id !== taskId;
  const paused = future && cycles.some(cycle => cycle.taskId === current.id
    && (cycle.green !== undefined || cycle.report !== undefined || ['GREEN', 'IMPLEMENTED', 'REFACTOR', 'VERIFIED'].includes(cycle.step)));
  return { currentTaskId: current?.id, future, paused };
}

function captainDecision(taskId, cycleId, why) {
  return { who: 'captain', tool: 'pair_arbitrate', taskId, ...(cycleId === undefined ? {} : { cycleId }), why };
}

function forSeat(team, role, obligation) {
  let who = role === 'driver' && team.parallel ? driverForTask(team, obligation.taskId) : seatName(team, role);
  if (role === 'driver' && team.parallel && !team.members.some(member => member.name === who && member.role === 'driver' && activeMember(member))) who = undefined;
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
 * The Captain's explicit escape hatch: giving an obligation up out loud.
 *
 * Measured (sg-career session, twice): "[PAIR:STALL] … 299s without board
 * progress". The Captain owed a structurally impossible pair_integrate — the
 * integration environment was missing the runtime data it needed — while a new
 * task t-4, scope-independent and ready, was never dispatched, and all four
 * seats sat idle. The frontier is not an order of business: the Captain's debt
 * and a member's claim are independent moves. But when the Captain cannot make
 * its move, the protocol had no way to say so except by writing another board
 * event, which is what the live session did, three times, to wake a team that
 * had work it could have been doing.
 *
 * A yield is its own durable record, and the frontier stops reporting what it
 * names. Three properties are deliberate:
 *
 *  - It is NOT a gate input. gateStateFingerprint does not read it, because
 *    giving up on an obligation must never stale the credential of the card it
 *    names — that would manufacture a second, unrelated debt and turn one
 *    stuck step into a loop.
 *  - It is NOT a prohibition. Whoever owns the call may still execute it
 *    directly; a yield means "stop reporting this as the team's next move",
 *    not "this can never happen".
 *  - It does NOT outlive the work it gave up. It holds only while the card it
 *    names has not moved; new cycle or gate evidence on that card brings the
 *    obligation back, so a yield cannot silently hide a later, different debt.
 */
function workRevision(protocol, taskId) {
  let latest = 0;
  const bump = (value) => { if (typeof value === 'number' && value > latest) latest = value; };
  for (const cycle of protocol?.cycles ?? []) {
    if (taskId !== undefined && cycle.taskId !== taskId) continue;
    bump(cycle.openedAt); bump(cycle.proposal?.at); bump(cycle.review?.at);
    bump(cycle.red?.at); bump(cycle.green?.at); bump(cycle.report?.at); bump(cycle.verify?.at);
  }
  for (const pass of protocol?.gatePasses ?? []) {
    if (taskId !== undefined && pass.taskId !== taskId) continue;
    bump(pass.at);
  }
  return latest;
}

/** The one durable pointer an obligation is named by. */
export function obligationRef(obligation) {
  if (obligation === undefined) return undefined;
  return obligation.taskId ?? obligation.cycleId ?? obligation.disclosureRef ?? obligation.discoveryId;
}

/** The yields whose card has not moved since they were recorded. */
export function yieldedObligations(team) {
  const protocol = team?.protocol ?? {};
  return (protocol.yields ?? []).filter(entry => entry.revision === workRevision(protocol, entry.taskId));
}

/** Record one Captain refusal to execute an owed call. Pure; the caller persists. */
export function recordYield(team, obligation, reason, by) {
  const entry = {
    tool: obligation.tool,
    who: obligation.who,
    ref: obligationRef(obligation),
    ...(obligation.taskId === undefined ? {} : { taskId: obligation.taskId }),
    ...(obligation.cycleId === undefined ? {} : { cycleId: obligation.cycleId }),
    revision: workRevision(team.protocol, obligation.taskId),
    reason: String(reason),
    by,
    at: Date.now(),
  };
  team.protocol.yields = [...(team.protocol.yields ?? []), entry];
  return entry;
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
  const unverified = unverifiedCycles(team?.protocol);
  const latest = new Map(cycles.map(cycle => [cycle.taskId, cycle]));
  const openTaskIds = new Set(unverified.map(cycle => cycle.taskId));
  const live = tasks.filter(liveTask);
  const builder = seatName(team, 'driver');
  const canonical = task => team.parallel || task.assignee === undefined || task.assignee === builder;
  const author = team?.mode === 'solo' ? 'spec' : 'navigator';
  const needsOracle = task => task.oracle === undefined
    && (team?.mode === 'solo' || (task.trivial !== true && (opts.oracleFirst ?? team?.oracleFirst) !== false));
  const oracleOwed = task => forSeat(team, author, {
    tool: 'pair_oracle', taskId: task.id,
    why: 'read pair_status(design_task_id) for this task contract and joint acceptance cases, then prepare and freeze the oracle in its reserved files; do not claim the implementation task',
  });
  const out = [];
  if (!isDispatchClosed(phase)) {
    for (const cycle of unverified) {
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
        const pass = team.protocol.gatePasses?.filter(item => item.taskId === task.id).at(-1);
        const candidateReady = pass?.id === task.gatePassId && pass?.binding?.gateStateSha === gateStateFingerprint(team, task.id)
          && pass?.binding?.taskAttempt?.attemptId === task.attemptId && pass?.binding?.taskAttempt?.assignee === task.assignee;
        if (team.parallel && candidateReady) {
          const integrated = team.parallel.integrations?.[task.id]?.candidate;
          out.push(integrated?.gatePassId === pass.id && integrated?.attemptId === task.attemptId && integrated?.worktreeSha === pass.binding.worktreeSha
            ? forSeat(team, 'driver', { tool: 'pair_task_update', taskId: task.id, why: 'the reviewed candidate is integrated; complete with this attempt_id and gate_pass_id' })
            : { who: 'captain', tool: 'pair_integrate', taskId: task.id, why: 'the reviewed candidate passed its gate; verify and integrate it serially before completion' });
        } else out.push(forSeat(team, 'driver', { tool: 'pair_gate_check', taskId: task.id, why: 'the latest cycle is accepted; run the task gate and complete it with the returned gate_pass_id' }));
      } else if (cycle?.verify?.verdict === 'checkpoint') {
        out.push(forSeat(team, 'driver', {
          tool: 'pair_propose', taskId: task.id,
          why: `the latest cycle is a checkpoint, not final acceptance; propose the next increment, or ask the verifier to promote ${cycle.id} with pair_verify(stage="final") when the full task is ready`,
        }));
      } else if (needsOracle(task)) out.push(oracleOwed(task));
      else out.push(forSeat(team, 'driver', { tool: 'pair_propose', taskId: task.id, why: 'open a small cycle; if using an oracle-free exemption, supply its no_oracle_reason again unless the task is trivial or oracle-first is disabled' }));
    }
    const ready = rankReadyTasks(tasks, task => task.status === 'pending' && task.handoffId === undefined
      && (task.dependencies ?? []).every(id => tasks.find(candidate => candidate.id === id)?.status === 'completed'));
    if (team.parallel) {
      const reserved = structuredClone(team);
      for (const member of team.members.filter(item => item.role === 'driver' && activeMember(item))) {
        const task = ready.find(item => claimEligibility(reserved, member, reserved.tasks.find(candidate => candidate.id === item.id)) === undefined);
        if (!task) continue;
        out.push({ who: member.name, tool: 'pair_task_claim', taskId: task.id, why: 'this independent scope is ready for your isolated workspace' });
        const reservation = reserved.tasks.find(item => item.id === task.id);
        reservation.status = 'claimed'; reservation.assignee = member.name;
      }
    } else if (!live.some(canonical)) {
      const task = ready.find(canonical);
      if (task !== undefined) out.push(forSeat(team, 'driver', { tool: 'pair_task_claim', taskId: task.id, why: 'this task is unclaimed and every dependency is completed' }));
    }
    for (const task of ready.filter(task => !team.parallel && canonical(task))) {
      if (needsOracle(task) && latest.get(task.id) === undefined) out.push(oracleOwed(task));
    }
    // The write API is confined to reserved oracle files. Freezing executes a
    // command against the shared candidate, so future work stays draft-only
    // until the current canonical task is terminal. There is no durable draft
    // marker in the existing API: unchanged-debt dedupe bounds its notification.
    for (const obligation of out) {
      if (obligation.tool === 'pair_oracle' && oraclePreparationWindow(team, obligation.taskId).future) {
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
  for (const discovery of team.product?.discoveries ?? []) {
    if (discovery.status === 'untriaged') out.push({ who: 'captain', tool: 'pair_backlog', discoveryId: discovery.id, why: 'triage the observed user value and evidence: schedule a prepared card, defer it, or dismiss with rationale; do not redirect an active Driver' });
  }
  const yielded = new Set(yieldedObligations(team).map(entry => entry.tool + '\0' + entry.ref));
  return out.filter(obligation => !obligation.preparationOnly || !oraclePreparationWindow(team, obligation.taskId).paused)
    .filter(obligation => !yielded.has(obligation.tool + '\0' + obligationRef(obligation)));
}

/** Compatible primary projection; pass a member name to select its own debt. */
export function nextObligation(team, recipient, opts = {}) {
  const frontier = obligationFrontier(team, opts);
  return recipient === undefined ? frontier[0] : frontier.find(obligation => obligation.who === recipient);
}

/**
 * Why the owed call cannot simply be made.
 *
 * "Idle seats: driver, navigator, challenger. Mail pending for: nobody." was
 * the entire content of two live stall reports, and it sent the Captain back to
 * the same call it had already failed to make. A stall report that cannot name
 * the blocker is a heartbeat with a timestamp, so the diagnosis carries this
 * projection: which obligation is blocking, what is holding it, which ready
 * work that is holding up, and the action that is actually available.
 *
 * Every line is derived from the same predicates the tools run — a ready card
 * is checked with claimEligibility itself — so the report cannot disagree with
 * the refusal a seat would get by trying.
 *
 * @returns {{who:string, tool:string, ref:*, blocking:string[], blocked_work:{taskId:string, reason:string}[], suggested_action:string}|undefined}
 */
export function blockingCause(team, opts = {}) {
  const owed = opts.obligation ?? nextObligation(team, opts.recipient, opts);
  if (owed === undefined) return undefined;
  const ref = obligationRef(owed);
  const tasks = team?.tasks ?? [];
  const drivers = (team?.members ?? []).filter(member => member.role === 'driver' && activeMember(member));
  const ready = rankReadyTasks(tasks, task => task.status === 'pending' && task.handoffId === undefined
    && (task.dependencies ?? []).every(id => tasks.find(candidate => candidate.id === id)?.status === 'completed'));
  const blocking = [];
  const blockedWork = [];
  for (const task of ready) {
    const refusals = drivers.map(member => ({ member: member.name, reason: claimEligibility(team, member, task) }));
    // One eligible Driver means this card is dispatchable and blocks nothing.
    if (refusals.length === 0 || refusals.some(row => row.reason === undefined)) continue;
    const reason = refusals.map(row => row.member + ': ' + row.reason).join('; ');
    blockedWork.push({ taskId: task.id, reason });
    const inFlight = new Set();
    for (const refusal of refusals) {
      const named = /in-flight ([^;,\s]+)/u.exec(String(refusal.reason));
      if (named !== null) inFlight.add(named[1]);
    }
    for (const id of inFlight) {
      const held = tasks.find(candidate => candidate.id === id);
      const owner = held?.assignee === undefined ? 'an unowned card' : held.assignee + ' still owns';
      const settled = (team?.protocol?.cycles ?? []).some(cycle => cycle.taskId === id && cycle.verify?.verdict === 'accept');
      blocking.push(owner + ' ' + id + ' in flight' + (settled ? ' with an accepted candidate' : '')
        + ', so its scope stays reserved and ' + task.id + ' cannot be claimed by anyone else');
    }
  }
  const alreadyYielded = yieldedObligations(team)
    .some(entry => entry.tool === owed.tool && entry.ref === ref);
  if (owed.who === 'captain') {
    blocking.push('only the Captain may make this call, so no member can take it over while it stands');
  } else if (!(team?.members ?? []).some(member => member.name === owed.who && activeMember(member))) {
    blocking.push('the ' + owed.who + ' seat has no live member to make the call');
  }
  if (alreadyYielded) {
    blocking.push('you already yielded this obligation and the card it names has not moved since');
  }
  const blockedIds = [...new Set(blockedWork.flatMap(row => (row.reason.match(/in-flight ([^;,\s]+)/gu) ?? [])
    .map(text => text.slice('in-flight '.length))))];
  const suggestion = owed.who === 'captain'
    ? 'execute it if you can; when you cannot, give it up explicitly with pair_yield(tool='
      + JSON.stringify(owed.tool) + (ref === undefined ? '' : ', task_id=' + JSON.stringify(ref)) + ')'
      + (blockedIds.length > 0 ? ' and clear ' + blockedIds.join(', ') + ' so the ready work can be claimed' : '')
    : 'wake ' + owed.who + ' (the scheduler sweep does this) or reassign the work; a member step is not the Captain\u2019s to execute';
  return { who: owed.who, tool: owed.tool, ref, blocking, blocked_work: blockedWork, suggested_action: suggestion };
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
      : obligation.discoveryId !== undefined
        ? `action=triage, discovery_id=${obligation.discoveryId}`
        : `task_id=${obligation.taskId}`;
  const call = `${obligation.tool}(${target})`;
  // Third person is an inference the reader has to make, and a seat deep in a
  // long context makes it wrong: it reads "navigator owes pair_review" as a
  // status report about somebody else and ends its turn. Nothing is pending
  // afterwards — the message was consumed — so the board freezes with an empty
  // mailbox and no seat believing it holds the baton. When the reader IS the
  // owed party, say so in the second person and say what happens if it stops.
  if (recipient !== undefined && recipient === obligation.who) {
    return `[PAIR:NEXT] YOU owe ${call} — ${obligation.why}. You are the last runner on this task: nothing advances it until you make that call, and no timer will make it for you. Other seats may still have independent work. Do not end your turn before it; if you cannot make it, say why and name who can.`;
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
