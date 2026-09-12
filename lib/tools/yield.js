/**
 * pair_yield: the Captain gives up an obligation it cannot execute.
 *
 * Measured (sg-career session, twice): "[PAIR:STALL] … 299s without board
 * progress". The Captain owed a structurally impossible pair_integrate (the
 * integration environment was missing the runtime data) while a new task t-4 —
 * scope-independent, ready, unclaimed — was never dispatched, and all four
 * seats sat idle. The recorded remedy in that session was to write a ruling,
 * because a board write was the only move that reliably moved anything. That is
 * not an escape hatch; it is the deadlock with extra steps and a growing
 * decision log.
 *
 * This tool is the explicit version: name the obligation you cannot execute,
 * say why, and the frontier stops reporting it as the team's next move, so the
 * work that IS ready becomes the board's next move. The reason is required —
 * an unexplained yield is indistinguishable from an omission — and it is
 * recorded on the board, where pair_status reads it, instead of surviving only
 * in a transcript.
 *
 * @module dsh-pair-programming/tools/yield
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { withLock } from '../state/lock.js';
import { teamLockKey } from '../state/layout.js';
import { readTeam, writeTeam } from '../state/store.js';
import {
  nextObligation, obligationFrontier, obligationLine, obligationRef, recordYield, yieldedObligations,
} from '../protocol/obligation.js';
import { requireAgent, requireParticipantTeam, stateRootFor, workspaceOf, isCaptain } from './shared.js';

/** Just the fields a caller can act on, never the whole board. */
function brief(obligation) {
  if (obligation === undefined) return undefined;
  return { who: obligation.who, tool: obligation.tool,
    ...(obligationRef(obligation) === undefined ? {} : { ref: obligationRef(obligation) }),
    why: obligation.why };
}

export function registerYieldTools(ctx, config, runtime = {}) {
  ctx.tools.register(defineTool({
    name: 'pair_yield',
    description: 'Captain only: give up one obligation you cannot execute, with the reason. The frontier stops reporting it and the other ready work becomes the current move; pair_status still shows it as yielded. It records no ruling, spends no arbitration budget and does not stale any gate credential. Use it instead of writing a board event to wake a team that is waiting on a call you cannot make.',
    parameters: {
      tool: { type: 'string', required: true, description: 'The owed pair_* call you cannot execute, e.g. pair_integrate. It must be an obligation you actually hold right now.' },
      task_id: { type: 'string', description: 'The card the obligation names, when it names one (pair_integrate, pair_gate_check, pair_backlog …).' },
      cycle_id: { type: 'string', description: 'The cycle the obligation names, when it is a cycle step.' },
      reason: { type: 'string', required: true, description: 'What makes this call impossible for you right now. Recorded verbatim on the board.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.already_yielded === true
        ? `${value.yielded.tool} is already yielded for ${value.yielded.ref ?? 'this team'}.`
        : `Yielded ${value.yielded.tool}(${value.yielded.ref ?? '-'}): ${value.yielded.reason}`
          + (Array.isArray(value.frontier) && value.frontier.length > 0
            ? ` Still owed: ${value.frontier.join('; ')}.`
            // Naming the difference is the point: this list is tool calls a seat owes, while
            // pair_status.attention also carries standing items that are not calls at all — a
            // blocking risk, a stale credential, an unclaimed disclosure. Measured (#150): a
            // receipt that said nothing about the rest read as "you owe nothing" next to a board
            // that listed six captain items.
            : ' Nothing further is owed as a TOOL CALL. pair_status.attention may still list standing items that are not calls — a blocking risk, a stale credential, an unclaimed disclosure.') }],
    },
    async execute(args, exec) {
      if (typeof args.tool !== 'string' || args.tool.trim() === '') throw new Error('pair_yield needs the tool you are giving up, e.g. tool="pair_integrate"');
      if (typeof args.reason !== 'string' || args.reason.trim() === '') {
        throw new Error('pair_yield needs the reason you cannot execute this obligation — an unexplained yield is indistinguishable from an omission, and pair_status shows it to the whole team');
      }
      const agent = requireAgent(exec);
      const team = await requireParticipantTeam(agent, config);
      const stateRoot = stateRootFor(agent, config);
      const outcome = await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined || ['DONE', 'ABORTED'].includes(fresh.protocol.phase)) throw new Error('pair_yield requires an active team');
        if (!isCaptain(fresh, agent)) {
          throw new Error('only the Captain may yield a Captain obligation — a member that cannot make its call says so in pair_status and the Captain rules on it');
        }
        // Idempotence first. A yield REMOVES its obligation from the frontier,
        // so asking again is not "the board does not owe you this" — it is the
        // same Captain, the same card, the same impossibility, and it must stay
        // one record instead of a pile of identical rulings (the yield is kept
        // in the durable board and shown by pair_status, so re-yielding is a
        // no-op, not a second event).
        const live = yieldedObligations(fresh);
        const sameTool = live.filter(entry => entry.tool === args.tool);
        const argRef = args.task_id ?? args.cycle_id;
        const existing = argRef === undefined
          ? (sameTool.length === 1 ? sameTool[0] : undefined)
          : sameTool.find(entry => entry.ref === argRef);
        if (existing !== undefined) {
          return { already_yielded: true, yielded: existing, next: brief(nextObligation(fresh, undefined, { oracleFirst: config.oracleFirst })) };
        }
        const mine = obligationFrontier(fresh, { oracleFirst: config.oracleFirst }).filter(obligation => obligation.who === 'captain');
        const matching = mine.filter(obligation => obligation.tool === args.tool
          && (args.task_id === undefined || obligation.taskId === args.task_id)
          && (args.cycle_id === undefined || obligation.cycleId === args.cycle_id));
        if (matching.length > 1) {
          throw new Error(`you owe more than one ${args.tool}; name the one you are giving up with task_id or cycle_id`);
        }
        if (matching.length === 0) {
          const held = mine.map(obligation => obligation.tool + '(' + (obligationRef(obligation) ?? '-') + ')').join(', ');
          throw new Error(`the board does not owe you ${args.tool}${args.task_id === undefined ? '' : '(' + args.task_id + ')'} — a yield must name an obligation you actually hold. You currently owe: ${held === '' ? 'nothing' : held}`);
        }
        const obligation = matching[0];
        const entry = recordYield(fresh, obligation, args.reason.trim(), agent.id);
        await writeTeam(stateRoot, fresh);
        const after = await readTeam(stateRoot, team.id);
        const next = nextObligation(after, undefined, { oracleFirst: config.oracleFirst });
        return {
          already_yielded: false, yielded: entry,
          next: brief(next),
          next_line: obligationLine(next),
          frontier: obligationFrontier(after, { oracleFirst: config.oracleFirst })
            .map(candidate => candidate.who + ' owes ' + candidate.tool),
        };
      });
      // The work that was standing behind this obligation does not start itself:
      // every other ready debt is dispatched from the board, so the board has to
      // be read again by the seats that hold them.
      if (outcome.already_yielded !== true) {
        const kicked = runtime.scheduler?.kickTeam?.(workspaceOf(agent), team.id);
        if (kicked !== undefined) await Promise.resolve(kicked).catch(() => undefined);
      }
      return outcome;
    },
  }));
}
