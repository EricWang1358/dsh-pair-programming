/**
 * The Attention Set: everything this board needs a human or a seat to act on,
 * recomputed from durable state on every wake.
 *
 * Why this exists. `nextObligation` answers exactly one question — whose move
 * is it — and it answers it well. But a board can be blocked on things that
 * are not "a move": a declared blind spot nobody ruled on, a P0 that outranks
 * the cycle in flight, a gate credential that went stale when the worktree
 * moved under it, a seat whose last turn was cut off at the token ceiling.
 * Each of those had its own ad-hoc reader — pair_stop computed stale
 * credentials, the scheduler computed stalls, the digest printed the
 * obligation — and three readers of one board drift apart.
 *
 * So this module is the ONE projection. It is recomputed from the team record
 * at every wake rather than maintained as a list, because a maintained list is
 * a second truth that can disagree with the board — the exact failure this
 * protocol keeps paying for. Seeing an item is not treating it: an item leaves
 * the set only when the underlying board state changes.
 *
 * Pure logic, unit-testable.
 *
 * @module dsh-pair-programming/protocol/attention
 */
import { nextObligation } from './obligation.js';
import { openDisclosures, unsunkResiduals } from './disclosure.js';
import { openBlockingRisks } from './risks.js';
import { gateStateFingerprint } from './gate.js';

/**
 * How many bounded resumes one seat may be granted for the SAME debt after its
 * turn was truncated at the token ceiling. Past this the seat is parked and the
 * captain is told: a third identical continuation is not recovery, it is a loop
 * that bills for itself.
 */
export const MAX_TOKEN_RESUMES = 2;

/** Kinds in the order they outrank each other. Lower index = more urgent. */
export const ATTENTION_KINDS = Object.freeze([
  'blocking-risk',
  'stale-credential',
  'truncated-seat',
  'obligation',
  'disclosure',
  'unsunk-residual',
]);

const rank = (kind) => {
  const index = ATTENTION_KINDS.indexOf(kind);
  return index === -1 ? ATTENTION_KINDS.length : index;
};

/**
 * Normalize a recorded turn-end reason to its kind string.
 *
 * The host writes `turn/end` with a structured `reason` (`{ kind: 'max-tokens' }`),
 * while this plugin's own `agent/error` path records the bare string `'error'`.
 * Both shapes are already on disk in live team records, so every reader goes
 * through here rather than restating the union.
 */
export function turnEndKind(lastTurn) {
  const reason = lastTurn?.endReason;
  if (typeof reason === 'string') return reason;
  if (typeof reason?.kind === 'string') return reason.kind;
  return undefined;
}

/** Whether a seat's last turn was cut off at the output-token ceiling. */
export function wasTruncated(member) {
  return turnEndKind(member?.lastTurn) === 'max-tokens';
}

/**
 * The debt key one bounded-resume budget is scoped to. A resume budget belongs
 * to ONE owed call on ONE board revision: when the board moves the seat made
 * progress and earns a fresh budget; when it does not, the same budget keeps
 * counting down. Long truncated prose is not progress — only a board mutation
 * changes `updatedAt`.
 */
export function debtKey(team, obligation) {
  if (obligation === undefined) return undefined;
  const subject = obligation.cycleId ?? obligation.taskId ?? obligation.disclosureRef ?? '-';
  return `${obligation.tool}::${subject}::${team?.updatedAt ?? 0}`;
}

/**
 * Seats whose last turn hit the token ceiling while they still owe the board,
 * with how much of their bounded-resume budget is left.
 *
 * @returns {{name:string, resumes:number, remaining:number, exhausted:boolean}[]}
 */
export function truncatedSeats(team, opts = {}) {
  const max = opts.maxResumes ?? MAX_TOKEN_RESUMES;
  const owed = opts.obligation ?? nextObligation(team);
  const key = debtKey(team, owed);
  const out = [];
  for (const member of team?.members ?? []) {
    if (member.status === 'removed' || member.id === '') continue;
    if (!wasTruncated(member)) continue;
    // Truncation only matters while this seat still owes something. A seat cut
    // off after its call landed is not stuck; it is finished and verbose.
    if (owed === undefined || owed.who !== member.name) continue;
    const resumes = member.resume?.debt === key ? Number(member.resume?.count ?? 0) : 0;
    out.push({ name: member.name, resumes, remaining: Math.max(0, max - resumes), exhausted: resumes >= max });
  }
  return out;
}

/** Completed cards whose gate credential no longer binds to the current board. */
export function staleCredentials(team, opts = {}) {
  const passes = team?.protocol?.gatePasses ?? [];
  const latestFor = (taskId) => passes.filter(p => p.taskId === taskId).at(-1);
  const out = [];
  for (const task of team?.tasks ?? []) {
    if (task.status !== 'completed') continue;
    const pass = latestFor(task.id);
    if (pass === undefined || pass.id !== task.gatePassId) {
      out.push({ taskId: task.id, why: 'the card carries no matching gate credential' });
      continue;
    }
    if (pass.binding?.gateStateSha !== gateStateFingerprint(team, task.id)) {
      out.push({ taskId: task.id, why: 'the board moved after the gate ran' });
      continue;
    }
    if (typeof opts.worktreeSha === 'string' && pass.binding?.worktreeSha !== opts.worktreeSha) {
      out.push({ taskId: task.id, why: 'the worktree moved after the gate ran' });
    }
  }
  return out;
}

/**
 * Everything this board needs acted on, most urgent first.
 *
 * @param {object} team - the durable team record.
 * @param {{worktreeSha?:string, maxResumes?:number}} [opts]
 * @returns {{items:object[], primary:object|undefined, obligation:object|undefined}}
 */
export function attentionSet(team, opts = {}) {
  const obligation = nextObligation(team);
  const items = [];

  for (const risk of openBlockingRisks(team?.protocol ?? {}, ['P0', 'P1'])) {
    items.push({
      kind: 'blocking-risk', who: 'captain', tool: 'pair_risk_close', ref: risk.id,
      why: `${risk.severity} risk ${risk.id} is ${risk.status} — it outranks the cycle in flight and blocks any successful stop`,
    });
  }
  for (const stale of staleCredentials(team, opts)) {
    items.push({
      kind: 'stale-credential', who: 'driver', tool: 'pair_gate_check', ref: stale.taskId,
      why: `${stale.taskId} is completed but its gate credential no longer binds — ${stale.why}; re-run the gate`,
    });
  }
  for (const seat of truncatedSeats(team, { ...opts, obligation })) {
    items.push({
      kind: 'truncated-seat',
      who: seat.exhausted ? 'captain' : seat.name,
      tool: seat.exhausted ? 'pair_arbitrate' : (obligation?.tool ?? 'pair_status'),
      ref: seat.name,
      why: seat.exhausted
        ? `${seat.name} was cut off at the token ceiling ${seat.resumes} time(s) on the same owed call — the bounded resume budget is spent, so rule on it instead of continuing`
        : `${seat.name} was cut off at the token ceiling with the same call still owed — continue from the current board state (${seat.remaining} bounded resume(s) left), do not restart the work`,
    });
  }
  if (obligation !== undefined) {
    items.push({
      kind: 'obligation', who: obligation.who, tool: obligation.tool,
      ref: obligation.cycleId ?? obligation.taskId ?? obligation.disclosureRef,
      why: obligation.why, obligation,
    });
  }
  for (const item of openDisclosures(team)) {
    items.push({
      kind: 'disclosure', who: 'captain', tool: 'pair_arbitrate', ref: item.ref,
      why: `${item.kind}: ${item.text} — nobody has ruled on it`,
    });
  }
  // Rulings recorded before V5.2 closed a gap without saying what happened to
  // it. They are not blocked (the enforcement point is the tool, and nothing
  // written from here on can reach this state) but they are visible, because a
  // residual whose only home is a transcript is the failure V5.2 exists for.
  for (const row of unsunkResiduals(team)) {
    items.push({
      kind: 'unsunk-residual', who: 'captain', tool: 'pair_arbitrate', ref: row.ref,
      why: `ruling ${row.decisionId} closed this gap as "${row.disposition}" without naming where the residual lives — record a sink before relying on it being tracked`,
    });
  }

  items.sort((a, b) => rank(a.kind) - rank(b.kind));
  return { items, primary: items[0], obligation };
}

/** The multi-line `[PAIR:ATTENTION]` block every consumer prints from one projection. */
export function attentionLines(set, opts = {}) {
  const limit = opts.limit ?? 8;
  if (set.items.length === 0) return '[PAIR:ATTENTION] empty — nothing on this board needs action.';
  const rows = set.items.slice(0, limit)
    .map(item => `  - [${item.kind}] ${item.who} :: ${item.tool}(${item.ref ?? '-'}) — ${item.why}`);
  const more = set.items.length > limit
    ? [`  - …and ${set.items.length - limit} more (read pair_status)`]
    : [];
  return [`[PAIR:ATTENTION] ${set.items.length} item(s), most urgent first:`, ...rows, ...more].join('\n');
}
