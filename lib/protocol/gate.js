/**
 * The quality gate: the checklist executor that must pass before any task may
 * be marked completed. This is the hard enforcement point — pair_task_update
 * refuses status=completed without a valid gate pass from here.
 *
 * Pure logic over the team record — unit-testable.
 *
 * @module dsh-pair-programming/protocol/gate
 */

import { taskDesignContext } from './design.js';
import { isBookkeepingRuling } from './disclosure.js';
import { createHash } from 'node:crypto';
import { openBlockingRisks } from './risks.js';

/** The card as the digest sees it. */
function gateBoundTask(task) {
  const {
    gatePassId: _gatePassId, updatedAt: _updatedAt, status: _status,
    assignee: _assignee, attemptId: _attemptId, handoffId: _handoffId,
    ...boundTask
  } = task ?? {};
  // Feature output is a completion summary, not a gate input. A spike output
  // is the decision/estimate the gate explicitly checks, so keep that one.
  if (task?.type !== 'spike') delete boundTask.output;
  return boundTask;
}

/**
 * One cycle as the digest sees it: the input breakdown this module writes into
 * `verify.binding` is removed first. Without this, recording what a credential
 * was bound to would move the very digest it records, and every gate pass
 * would stale the review binding it had just verified.
 */
function gateBoundCycle(cycle) {
  // Appended corrections are excluded for the same reason the input breakdown is: recording that a
  // number on the record was wrong must not invalidate the credential that judged the candidate.
  // Measured (#153): a wrong number could not be corrected at all, and the naive fix — let the write
  // move the digest — would have re-created the ordering dead end #131 fixed.
  const { corrections: _corrections, ...cycleBody } = cycle ?? {};
  const binding = cycleBody.verify?.binding;
  if (binding === undefined || (binding.breakdown === undefined && binding.breakdownIndex === undefined)) return cycleBody;
  const { breakdown: _breakdown, breakdownIndex: _breakdownIndex, ...kept } = binding;
  return { ...cycleBody, verify: { ...cycleBody.verify, binding: kept } };
}

/**
 * The worktree digest catches file changes. This sibling catches board-only
 * changes after a pass: a newly raised blocker, a new cycle, a changed card,
 * or a new task-scoped ruling. Volatile member activity, stats, timestamps and
 * the credential itself are excluded so a harmless scheduler heartbeat does
 * not invalidate a pass.
 *
 * WHAT MAY MOVE IT IS A MATRIX, NOT "THE BOARD CHANGED".
 *
 * Measured failure (SG-career dual-driver session, 2026-09-10): two GATE_STALE
 * refusals in one session, each bought back with a reopened cycle and a fresh
 * final ACCEPT — three cycles that changed no product byte. The writes that
 * tripped them were the rulings the board itself demands (`d-1b044190`,
 * `d-5772aca2`, recorded to close disclosures OF THE VERY CYCLE they then
 * invalidated) and an amend of an unrelated card. Bookkeeping that exists to
 * satisfy the board negated the verdict it was serving.
 *
 * So each input below is judged on purpose:
 *
 *   task       the card's own contract. A requirement, acceptance or
 *              deliverable change still invalidates; volatile fields
 *              (timestamps, live status, attempt identity) never did.
 *   design     taskDesignContext(team, task): the criteria THIS card owns and
 *              the use-case design it implements. It is the only path by which
 *              another card could reach this digest, and it does not carry
 *              one: an amend or a landing of a sibling card touches that
 *              sibling's record, and acceptanceRefs select criteria by id out
 *              of a use case frozen at pair_start (see the matrix suite).
 *   cycles     this task's cycles, without the input breakdown this module
 *              stores inside their verify binding — a credential must not be
 *              invalidated by the note that records what it was bound to.
 *   risks      every P0/P1 on the board, as a TICKET — identity, severity,
 *              scenario, trigger, suggestion, raiser, scope — and never its
 *              lifecycle status. Risks carry no task attribution (the register
 *              is team-wide), so a blocker found on ANOTHER card still
 *              invalidates this one: it is exactly the case where the verdict
 *              must be recomputed, and the gate cannot tell whose work it came
 *              from. Why the status is absent is argued at gateBoundRisk.
 *   decisions  rulings attributed to this task — minus the ones that only
 *              discharged a declared disclosure. Those are the board's own
 *              paperwork (a successful stop is refused while a disclosure is
 *              unclaimed), so they cannot change what was accepted. A ruling
 *              that is a genuine new dispute is billed as one and stays in.
 *
 * The one direction this digest DOES encode is in which facts it hashes, and
 * that is not the same as a directional comparison: "a new blocker invalidates
 * but a closed one does not" is two rules, while "the register of P0/P1
 * tickets is hashed, their lifecycle is not" is one symmetric rule that happens
 * to have both effects. See gateBoundRisk for the measurement that forced it.
 */
/**
 * One risk as the digest sees it: the ticket, never its lifecycle.
 *
 * An allowlist rather than a denylist — a denylist would let the next lifecycle
 * field (a confirmation note, a re-open stamp) reintroduce exactly the
 * invalidation this removes, silently. Adding a field to openRisk therefore
 * means deciding, here, whether a credential should bind it.
 *
 * Measured failure (SG-career, 2026-09-11): the Navigator recorded a final
 * ACCEPT, the captain closed r-1 — the very thing the gate waits for, since a
 * P0/P1 blocks completion until it is CLOSED or WONTFIX — and the gate answered
 * GATE_STALE, on t-2 once and on t-1 twice. Every remedy the error names (a
 * reopened cycle with a fresh final review) closes the next blocker the same
 * way, so the loop only ratchets. What resolves a blocker cannot be what
 * invalidates the review that made resolving it possible; and nothing is judged
 * less strictly for it, because the gate re-reads the LIVE blocking set
 * (openBlockingRisks) when it runs.
 */
const BOUND_RISK_FIELDS = Object.freeze(['id', 'severity', 'scenario', 'trigger', 'suggestion', 'raisedBy', 'scope', 'taskId', 'openedAt']);
function gateBoundRisk(risk) {
  const bound = {};
  for (const field of BOUND_RISK_FIELDS) if (risk?.[field] !== undefined) bound[field] = risk[field];
  return bound;
}
function gateStatePayload(team, taskId) {
  const task = (team?.tasks ?? []).find(item => item.id === taskId);
  const protocol = team?.protocol ?? {};
  const design = taskDesignContext(team, task);
  return {
    task: gateBoundTask(task),
    ...(design.length ? { design } : {}),
    cycles: (protocol.cycles ?? []).filter(cycle => cycle.taskId === taskId).map(gateBoundCycle),
    // P2 is intentionally absent: runGate does not block on it, so raising a
    // style/optimization backlog item must not stale an otherwise valid pass.
    risks: (protocol.risks ?? []).filter(risk => risk.severity === 'P0' || risk.severity === 'P1').map(gateBoundRisk),
    decisions: (protocol.decisions ?? []).filter(decision => decision.taskId === taskId && !isBookkeepingRuling(decision)),
  };
}

/**
 * Hash only the board facts one task gate actually judges.
 * One hash over every input gateStatePayload builds; that function says what
 * each input may and may not move.
 */
export function gateStateFingerprint(team, taskId) {
  return createHash('sha256').update(JSON.stringify(gateStatePayload(team, taskId))).digest('hex');
}

const digestOf = value => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');

/**
 * Each judged input as its own digest, one entry per fingerprint input.
 *
 * A single credential digest can only say THAT something moved. Measured: the
 * captain spent five source-reading sessions working out which input had
 * changed, because the refusal named none of them. Stored beside the
 * credential, this breakdown turns the next refusal into "decisions: added
 * d-1b044190".
 */
export function gateStateBreakdown(team, taskId) {
  return breakdownOf(gateStatePayload(team, taskId));
}

function breakdownOf(payload) {
  return {
    task: digestOf(payload.task),
    // Absent design means "no design context"; the payload omits the key for
    // byte-compatibility with credentials minted before this breakdown existed.
    design: digestOf(payload.design ?? []),
    cycles: digestOf(payload.cycles),
    risks: digestOf(payload.risks),
    decisions: digestOf(payload.decisions),
  };
}

/** Dotted leaf paths of a card's own fields, so "story.intent changed" is nameable. */
function foldFields(value, prefix = '') {
  const out = {};
  for (const [key, item] of Object.entries(value ?? {})) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) Object.assign(out, foldFields(item, path));
    else out[path] = item;
  }
  return out;
}

function indexOf(pairs) {
  const out = {};
  for (const [key, item] of pairs) {
    if (key === undefined || key === null || key === '') continue;
    out[key] = digestOf(item);
  }
  return out;
}

/**
 * The same inputs, indexed by the id inside them. The digests above prove an
 * input moved; this index is what lets a refusal say WHICH id moved, so it
 * travels beside the breakdown on the credential.
 */
export function gateStateIndex(team, taskId) {
  return indexOfPayload(gateStatePayload(team, taskId));
}

function indexOfPayload(payload) {
  return {
    task: indexOf(Object.entries(foldFields(payload.task))),
    design: indexOf((payload.design ?? []).map(entry => [entry?.useCase, entry])),
    cycles: indexOf(payload.cycles.map(cycle => [cycle?.id, cycle])),
    risks: indexOf(payload.risks.map(risk => [risk?.id, risk])),
    decisions: indexOf(payload.decisions.map(decision => [decision?.id, decision])),
  };
}

/** What a credential records about the inputs it just judged. */
export function gateBindingRecord(team, taskId) {
  const payload = gateStatePayload(team, taskId);
  return { breakdown: breakdownOf(payload), breakdownIndex: indexOfPayload(payload) };
}

const GATE_STATE_INPUTS = Object.freeze(['task', 'design', 'cycles', 'risks', 'decisions']);

/**
 * What changed between a stored credential and the board as it stands now.
 *
 * Returns one line per changed item, each naming the input and the id — the
 * fact the captain otherwise has to reconstruct by reading this module. It is
 * empty when nothing differs, and it does not guess: a credential minted
 * before the breakdown existed (or by a caller that stored the breakdown
 * alone) yields no lines rather than an invented one.
 */
export function gateBindingDiff(team, taskId, binding) {
  const recorded = binding?.breakdown;
  if (recorded === null || recorded === undefined) return [];
  const payload = gateStatePayload(team, taskId);
  const current = breakdownOf(payload);
  const currentIndex = indexOfPayload(payload);
  const recordedIndex = binding?.breakdownIndex;
  const lines = [];
  for (const input of GATE_STATE_INPUTS) {
    if (recorded[input] === undefined || recorded[input] === current[input]) continue;
    lines.push(...itemDiff(input, recordedIndex?.[input], currentIndex[input], payload));
  }
  return lines;
}

function labelOf(input, key, payload) {
  if (input === 'cycles') {
    const cycle = payload.cycles.find(item => item?.id === key);
    return cycle === undefined ? key : `${key}@${cycle.step ?? '?'}`;
  }
  if (input === 'risks') {
    const risk = payload.risks.find(item => item?.id === key);
    return risk === undefined ? key : `${key}(${risk.severity ?? '?'})`;
  }
  return key;
}

function itemDiff(input, before, after, payload) {
  // No id-level index was recorded beside the breakdown (a caller stored the
  // digests alone). Every id on the board would then read as "added", which is
  // a fabricated diff — so name only what is known: this input moved, and here
  // is what it holds now.
  if (before === undefined) {
    const now = Object.keys(after ?? {});
    const shown = now.slice(0, 8).join(', ');
    return [`${input}: input changed since this credential was issued (now: ${shown}${now.length > 8 ? `, +${now.length - 8} more` : ''}${now.length === 0 ? 'none' : ''})`];
  }
  // A card's own fields read "task: field \"story.intent\" changed"; a list of
  // records reads "decisions: added d-1b044190", the shape the measured
  // refusal needed to name the ruling that moved the credential.
  const field = input === 'task';
  const lines = [];
  const named = key => field ? `field "${key}"` : labelOf(input, key, payload);
  const say = (verb, key) => lines.push(field ? `${input}: ${named(key)} ${verb}` : `${input}: ${verb} ${named(key)}`);
  for (const key of Object.keys(after ?? {})) {
    if (before?.[key] === undefined) say('added', key);
    else if (before[key] !== after[key]) say('changed', key);
  }
  for (const key of Object.keys(before ?? {})) {
    if (after?.[key] === undefined) say('removed', key);
  }
  // The digest moved but no item can be named — say exactly that, and only
  // when the input itself is known to have changed.
  if (lines.length === 0) lines.push(`${input}: input changed since this credential was issued (${Object.keys(after ?? {}).length} item(s) now, ${Object.keys(before ?? {}).length} recorded)`);
  return lines;
}

/** The final review's board binding excludes binding fields themselves. */
export function reviewStateFingerprint(team, taskId) {
  const copy = structuredClone(team);
  for (const cycle of copy.protocol.cycles) {
    if (cycle.taskId === taskId && cycle.verify) delete cycle.verify.binding;
  }
  return gateStateFingerprint(copy, taskId);
}

/**
 * The Definition-of-Done check ids. This list is the Scrum DoD ("a common,
 * agreed checklist so everyone means the same thing by finished") made
 * configurable per deployment via config.dod.
 */
export const DEFAULT_DOD = Object.freeze([
  'all_accepted',        // every cycle is settled and at least one has a final ACCEPT
  'no_blocking_risks',   // no OPEN P0/P1 risk tickets
  'verify_evidence',     // the latest ACCEPT is a computed re-run (oracle) or carries evidence (legacy)
  'decisions_documented',// every arbitration in the task has a recorded rationale
  'test_first',          // (tddMode=enforce) accepted cycles show a RED step before GREEN
  'oracle_precedes_impl',// (N1) the acceptance oracle was frozen before the first cycle opened
  'oracle_replay',       // (N4) the gate re-ran the frozen oracle itself and it passed
  'spike_outcome',       // (spike tasks) a decision/estimate outcome is recorded
  'deliverables_present',// the files the task said it would produce actually exist
  'scope_declared',      // the diff touched only files a proposal declared
  'goal_criteria_traced',// every epic criterion on this card maps to an executable oracle case
]);

/** A rejected cycle is superseded only by the explicit re-freeze audit pair.
 * Arbitrary CLOSED records (or merely having a verdict) never erase debt. */
export function isSupersededRejectedCycle(cycle, oracle) {
  return cycle?.verify?.verdict === 'reject' && hasReplacementAudit(cycle, oracle?.supersededRejections);
}

/** Historical partial checks retain their evidence but no longer judge the new seal. */
export function isSupersededCheckpoint(cycle, oracle) {
  return cycle?.verify?.verdict === 'checkpoint' && cycle.verify.computed === true
    && cycle.verify.oracleSha === cycle.oracleSha
    && hasReplacementAudit(cycle, oracle?.supersededCheckpoints);
}

function hasReplacementAudit(cycle, records) {
  const closure = cycle?.closure;
  return cycle?.step === 'CLOSED'
    && closure?.reason === 'oracle-replaced' && closure.fromOracleSha === cycle.oracleSha
    && typeof closure.oracleSha === 'string' && closure.oracleSha !== ''
    && Number.isFinite(closure.at) && typeof closure.by === 'string' && closure.by !== ''
    && (records ?? []).some(record => record.cycleId === cycle.id
      && record.fromOracleSha === closure.fromOracleSha && record.oracleSha === closure.oracleSha
      && record.at === closure.at && record.by === closure.by);
}

/**
 * Run the completion gate checklist (the configurable Definition of Done)
 * for one task.
 *
 * @param {object} team - the durable team record.
 * @param {string} taskId - the task being completed.
 * @param {{tddMode?:string, dod?:string[], oracleReplay?:{ok:boolean, reason?:string}}} [opts] -
 *   DoD item selection, the session TDD mode (test_first only bites when
 *   tddMode === 'enforce'), and the gate's own oracle replay result (N4).
 * @returns {{pass:true, checklist:object} | {pass:false, failures:string[], checklist:object}}
 */
export function runGate(team, taskId, opts = {}) {
  const protocol = team.protocol;
  const task = team.tasks.find(t => t.id === taskId);
  const enabled = new Set(opts.dod ?? DEFAULT_DOD);
  const failures = [];
  const checklist = { taskId, dod: [...enabled], at: Date.now() };

  const oracle = task?.oracle;
  const allTaskCycles = protocol.cycles.filter(c => c.taskId === taskId);
  const taskCycles = allTaskCycles.filter(c => !isSupersededRejectedCycle(c, oracle));
  const currentOracleCycles = taskCycles.filter(c => !isSupersededCheckpoint(c, oracle));
  checklist.supersededRejectedCycles = allTaskCycles.filter(c => isSupersededRejectedCycle(c, oracle)).map(c => c.id);
  checklist.supersededCheckpointCycles = taskCycles.filter(c => isSupersededCheckpoint(c, oracle)).map(c => c.id);

  if (enabled.has('goal_criteria_traced') && (task?.acceptanceRefs ?? []).length > 0) {
    const missing = task.acceptanceRefs.filter(ref => !(oracle?.caseRefs ?? []).includes(ref));
    checklist.goalCriteria = { assigned: task.acceptanceRefs, executable: oracle?.caseRefs ?? [], missing };
    if (missing.length > 0) failures.push(`goal acceptance criteria lack executable oracle cases: ${missing.join(', ')}`);
  }

  // [ ] every cycle is settled; checkpointed slices do not replace a final ACCEPT.
  if (enabled.has('all_accepted')) {
    const unsettled = taskCycles.filter(c => !['accept', 'checkpoint'].includes(c.verify?.verdict));
    checklist.allAccepted = taskCycles.length > 0 && unsettled.length === 0 && taskCycles.at(-1)?.verify?.verdict === 'accept';
    checklist.checkpointCycles = taskCycles.filter(c => c.verify?.verdict === 'checkpoint').map(c => c.id);
    if (!checklist.allAccepted) {
      failures.push(taskCycles.length === 0
        ? 'task has no pair cycles — nothing was verified'
        : unsettled.length > 0
          ? `${unsettled.length} cycle(s) lack a computed checkpoint/final verdict: ${unsettled.map(c => c.id).join(', ')}`
          : 'the latest task cycle has no final oracle ACCEPT — run pair_verify(stage="final") on the last cycle');
    }
  }

  // [ ] no OPEN P0/P1 risk tickets.
  if (enabled.has('no_blocking_risks')) {
    // This card's blockers: an unattributed P0/P1 still blocks every card, but one that
    // names another card is that card's work (#126).
    const blocking = openBlockingRisks(protocol, ['P0', 'P1'], taskId);
    checklist.openBlockingRisks = blocking.map(r => `${r.id}(${r.severity})`);
    if (blocking.length > 0) {
      failures.push(`unresolved blocking risk(s): ${blocking.map(r => `${r.id}(${r.severity})`).join(', ')}`);
    }
  }

  // [ ] the acceptance was DERIVED, not asserted.
  //
  // v2 accepted `evidence.length > 0` here — a non-empty array of prose, which
  // the Driver's own report already satisfied, which is why a parroted ACCEPT
  // was structurally invisible to this gate. With a frozen oracle the bar is
  // that the ACCEPT is a recorded re-run; without one the legacy honour-system
  // check remains, and says so.
  if (enabled.has('verify_evidence')) {
    const lastAccept = [...taskCycles].reverse().find(c => c.verify?.verdict === 'accept');
    const hasEvidence = lastAccept !== undefined
      && Array.isArray(lastAccept.verify.evidence)
      && lastAccept.verify.evidence.length > 0;
    if (oracle !== undefined) {
      checklist.verifyPassed = lastAccept?.verify?.computed === true;
      if (!checklist.verifyPassed) {
        failures.push('the accepted cycle was not verified by re-running the frozen oracle — an oracle task cannot complete on an asserted verdict (re-run pair_verify)');
      }
    } else {
      checklist.verifyPassed = hasEvidence;
      checklist.verifyEvidenceIsHonourSystem = true;
      if (!checklist.verifyPassed) {
        failures.push('no ACCEPT carries verification evidence (test/build/lint result)');
      }
    }
  }

  // [ ] N1: the oracle predates the work it judges.
  //
  // The seal that must precede the work is the FIRST one, not the current one. Tightening a
  // standard is a supported move — the defect-fork path requires it — and it moves frozenAt past
  // every cycle the task already opened, so comparing frozenAt made the arm unsatisfiable forever
  // after any re-freeze: measured on SG-career, where the sanctioned way to fix the instrument
  // was the one way to make the card uncompletable (#125). An arm that cannot be satisfied is a
  // dead end, not a stricter rule.
  //
  // The teeth stay where they belong: an oracle that was frozen once, late, still compares that
  // one seal and is still refused — which is the arm's whole purpose and the control the
  // supersession test pins. What changes is only which seal a RE-FROZEN card is judged against.
  //
  // A board that re-froze before this field existed cannot answer the question at all, and failing
  // it for a fact its record does not hold is the same dead end in a different shape (#162): its
  // cards keep PASSING, and the gap is written down as oracleFirstSealUnmeasurable so a reader can
  // see that nothing was actually measured. What is NOT done is filling the gap with the record's
  // own frozenAt once the record HAS been re-frozen: that value is a later seal, and reading it as
  // the first would forgive exactly the late seal this arm exists to catch.
  if (enabled.has('oracle_precedes_impl') && oracle !== undefined) {
    const firstOpened = Math.min(...currentOracleCycles.map(c => c.openedAt ?? Number.POSITIVE_INFINITY));
    // Which seal answers the question. `firstFrozenAt` carries it. A record with forks === 1 has
    // never been re-frozen, so its own frozenAt IS the first seal — the fallback is a fact read off
    // the record (and it keeps the teeth: that seal is still compared against the first cycle).
    // Anything with forks > 1 that lacks the field was re-frozen before the field existed, and the
    // first seal is not recoverable from it.
    const firstSeal = oracle.firstFrozenAt ?? (oracle.forks === 1 ? oracle.frozenAt : undefined);
    if (firstSeal === undefined) {
      checklist.oraclePrecedesImpl = true;
      checklist.oracleFirstSealUnmeasurable = { frozenAt: oracle.frozenAt ?? null, forks: oracle.forks ?? null };
    } else {
      checklist.oraclePrecedesImpl = currentOracleCycles.length === 0 || firstSeal <= firstOpened;
      if (!checklist.oraclePrecedesImpl) {
        failures.push('the oracle was frozen AFTER the first cycle opened — an acceptance test written once an approach exists is no longer independent of it');
      }
    }
    // The audit stamp: the standard was MOVED forward after the card's cycles had already
    // progressed. `frozenAt > firstFrozenAt` alone fired on every re-freeze, including one made
    // while the card was still being planned — at that point there is no work for the standard to
    // postdate, so the line could not point at anything and drowned the case it exists for (#162).
    // "Already progressed" is read off the fields a cycle actually records, never invented: some
    // cycle of this task opened at or before the new seal AND carries judged work — a verify
    // verdict, or a RED / GREEN / report stamp. Any such cycle counts, not only the latest one: a
    // standard that postdates work done under it is what the reader needs, and a later cycle
    // opening after the seal does not un-date the earlier work. Records with no cycles at all, or
    // whose cycles are still untouched, do not move it.
    if (Number.isFinite(oracle.frozenAt) && Number.isFinite(oracle.firstFrozenAt) && oracle.frozenAt > oracle.firstFrozenAt) {
      const progressed = taskCycles.find(c =>
        (c.openedAt ?? Number.POSITIVE_INFINITY) <= oracle.frozenAt
        && (c.verify?.verdict !== undefined || c.red?.at !== undefined
          || c.green?.at !== undefined || c.report?.at !== undefined));
      if (progressed !== undefined) {
        // Not a failure: the standard moved forward, and the board should still be able to say so.
        checklist.oracleTightenedAfterImpl = {
          firstFrozenAt: oracle.firstFrozenAt, frozenAt: oracle.frozenAt, forks: oracle.forks ?? null,
          cycle: progressed.id, step: progressed.step ?? null,
        };
      }
    }
  }

  // [ ] N4: the gate re-ran the oracle itself rather than trusting the record.
  if (enabled.has('oracle_replay') && oracle !== undefined) {
    checklist.oracleReplay = opts.oracleReplay ?? { ok: false, reason: 'the gate did not replay the oracle' };
    if (checklist.oracleReplay.ok !== true) {
      failures.push(`the gate replay of the frozen oracle did not pass: ${checklist.oracleReplay.reason ?? 'unknown'}`);
    }
  }

  // [ ] every arbitration inside this task has a recorded rationale.
  if (enabled.has('decisions_documented')) {
    const undocumented = protocol.decisions.filter(d => d.taskId === taskId && (d.rationale === undefined || d.rationale === ''));
    checklist.undocumentedDecisions = undocumented.map(d => d.id);
    if (undocumented.length > 0) {
      failures.push(`${undocumented.length} arbitration(s) lack a recorded rationale`);
    }
  }

  // [ ] Test First: under enforce mode, each accepted cycle must carry RED
  // (failing-test) evidence before its GREEN (passing-implementation) step.
  // Trivial-task cycles are exempt (the "don't pair for typos" rule).
  if (enabled.has('test_first') && opts.tddMode === 'enforce') {
    const violated = taskCycles.filter(c =>
      (c.verify?.verdict === 'accept' || c.verify?.verdict === 'checkpoint') && c.trivial !== true
      && (!(c.red?.evidence?.length > 0) || !(c.green?.evidence?.length > 0)
        || (c.red?.at ?? Infinity) > (c.green?.at ?? -Infinity)));
    checklist.testFirstCompliant = violated.length === 0;
    if (violated.length > 0) {
      failures.push(`${violated.length} accepted cycle(s) violate Test First (no RED failing-test evidence before GREEN): ${violated.map(c => c.id).join(', ')} — production code must not exist before a failing test did`);
    }
  }

  // [ ] The task produced what it said it would produce.
  //
  // Measured failure: a task completed with a valid gate_pass_id while the
  // patch.diff and self-report.json its own contract named were never written.
  // Every other DoD item was green, because every other item asks about the
  // PROCESS. Nothing asked whether the artifact exists. An acceptance oracle
  // proves the behaviour is right; it says nothing about whether anyone
  // actually handed over the thing that was ordered.
  if (enabled.has('deliverables_present') && (task?.deliverables ?? []).length > 0) {
    const report = opts.deliverableCheck;
    checklist.deliverables = report ?? { ok: false, reason: 'the gate did not check the declared deliverables' };
    if (checklist.deliverables.ok !== true) {
      failures.push(`declared deliverable(s) missing or empty: ${(checklist.deliverables.missing ?? []).join(', ') || checklist.deliverables.reason}`);
    }
  }

  // [ ] The change stayed inside the scope the team declared.
  //
  // A cycle declares files[] before it is allowed to start. When the diff
  // reaches files nobody proposed, the work grew past the plan without anyone
  // deciding to let it — which is how a fix aimed at one behaviour quietly
  // rewrites another and regresses it. Line-count drift is recorded but never
  // fails on its own: estimating net lines up front is honest guesswork.
  if (enabled.has('scope_declared')) {
    const report = opts.scopeCheck;
    if (report !== undefined) {
      checklist.scope = report;
      if (report.undeclared?.length > 0) {
        failures.push(`the diff touched file(s) no proposal declared: ${report.undeclared.join(', ')} — declare them in a proposal (and let the Navigator see the wider blast radius) or revert them`);
      }
    }
  }

  // [ ] A spike's deliverable is the decision, not code: record the outcome.
  if (enabled.has('spike_outcome') && task?.type === 'spike') {
    checklist.spikeOutcomeRecorded = String(task.output ?? '').trim() !== '';
    if (!checklist.spikeOutcomeRecorded) {
      failures.push('spike task completes without an outcome — record the go/no-go decision or the estimate the research was meant to buy');
    }
  }

  // [ ] No second scheduler drove this worktree while the task was built.
  //
  // A gate credential binds a claim to a board and a worktree. If another loop
  // — a Compound Engineering execution or shipping skill loaded from some other
  // skill root — was also driving that worktree during the window, the binding
  // describes a state nobody owned. This plugin never serves those skills, so a
  // hit here always means a second root; the refusal says so and says how the
  // attribution was made, because the ledger knows a workspace and a time, not
  // a seat. An unreadable ledger is a failure too: "we could not look" must
  // never resolve the same way as "nothing happened".
  if (opts.ceLoads !== undefined) {
    const report = opts.ceLoads;
    checklist.ceLoads = { readable: report.readable !== false, count: (report.loads ?? []).length };
    if (report.readable === false) {
      failures.push('the Compound Engineering load ledger could not be read, so the gate cannot show that no second execution loop drove this worktree — fix or remove the ledger and re-run');
    } else {
      const violation = report.violation;
      if (violation !== undefined && violation.ok === false) failures.push(violation.reason);
    }
  }

  return failures.length === 0
    ? { pass: true, checklist }
    : { pass: false, failures, checklist };
}
