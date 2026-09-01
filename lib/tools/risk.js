/**
 * Risk tool: pair_risk — the Challenger's RAISE/CLEAR channel and the risk
 * register mutations. A P0 raise steers the captain immediately.
 *
 * @module dsh-pair-programming/tools/risk
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { withLock } from '../state/lock.js';
import { stateRootFor, requireAgent, requireParticipantTeam, deliverProtocolMessage } from './shared.js';
import { teamLockKey } from '../state/layout.js';
import { readTeam, writeTeam } from '../state/store.js';
import { encodeMessage } from '../protocol/messages.js';
import { openRisk, mitigateRisk, closeRisk, wontfixRisk, raiseBudgetExhausted, raiseBudgetMessage } from '../protocol/risks.js';
import { isCaptain } from './shared.js';

export function registerRiskTools(ctx, config, runtime) {
  ctx.tools.register(defineTool({
    name: 'pair_risk',
    description: 'Manage one risk ticket. Challenger raises (action=raise, with severity/scenario/trigger/suggestion); Driver mitigates (action=mitigate + evidence); Navigator closes (action=close + evidence); Captain rules a false alarm (action=wontfix + rationale). A P0 raise notifies the captain immediately and bypasses the raise budget; a P1/P2 raise is refused once `maxOpenRisks` tickets are already open.',
    parameters: {
      action: { type: 'string', required: true, description: 'raise | mitigate | close | wontfix' },
      severity: { type: 'string', description: 'P0 | P1 | P2 (required on raise)' },
      scenario: { type: 'string', description: 'How the failure manifests (required on raise)' },
      trigger: { type: 'string', description: 'What input/state triggers it (required on raise)' },
      suggestion: { type: 'string', description: 'Concrete mitigation (required on raise)' },
      risk_id: { type: 'string', description: 'The risk ticket id (required on mitigate/close/wontfix)' },
      evidence: { type: 'string', description: 'Fix/confirm evidence (mitigate/close)' },
      rationale: { type: 'string', description: 'Why it is a false alarm (wontfix)' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Risk ${v.risk_id}: ${v.status}.` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const stateRoot = stateRootFor(agent, config);
      const team = await requireParticipantTeam(agent, config);
      const caller = team.members.find(m => m.id === agent.id && m.status !== 'removed');
      const callerRole = isCaptain(team, agent) ? 'captain' : caller?.role;

      let result;
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        switch (args.action) {
          case 'raise': {
            if (callerRole !== 'challenger' && callerRole !== 'navigator' && callerRole !== 'captain') {
              throw new Error('only the Challenger (or Navigator/Captain) can raise a risk');
            }
            if (args.severity !== 'P0') {
              const budget = raiseBudgetExhausted(fresh.protocol, config.maxOpenRisks ?? 15);
              if (budget.exhausted) throw new Error(raiseBudgetMessage(budget));
            }
            const risk = openRisk(fresh.protocol, {
              severity: args.severity, scenario: args.scenario, trigger: args.trigger,
              suggestion: args.suggestion, raisedBy: callerRole,
            });
            result = { risk_id: risk.id, status: risk.status, severity: risk.severity };
            break;
          }
          case 'mitigate': {
            const risk = mitigateRisk(fresh.protocol, requireArg(args.risk_id, 'risk_id'), requireArg(args.evidence, 'evidence'));
            result = { risk_id: risk.id, status: risk.status };
            break;
          }
          case 'close': {
            if (callerRole !== 'navigator' && callerRole !== 'captain') {
              throw new Error('only the Navigator (or Captain) can close a risk');
            }
            const risk = closeRisk(fresh.protocol, requireArg(args.risk_id, 'risk_id'), requireArg(args.evidence, 'evidence'));
            result = { risk_id: risk.id, status: risk.status };
            break;
          }
          case 'wontfix': {
            if (callerRole !== 'captain') throw new Error('only the Captain can rule a risk a false alarm');
            const risk = wontfixRisk(fresh.protocol, requireArg(args.risk_id, 'risk_id'), requireArg(args.rationale, 'rationale'));
            result = { risk_id: risk.id, status: risk.status };
            break;
          }
          default:
            throw new Error(`unknown risk action "${args.action}"`);
        }
        await writeTeam(stateRoot, fresh);
      });

      // A fresh P0 steers the captain immediately; everything else notifies too.
      const isP0 = args.action === 'raise' && args.severity === 'P0';
      const to = 'captain';
      const type = args.action === 'raise' ? 'RAISE' : 'CLEAR';
      await deliverProtocolMessage(ctx, config, agent, team, to,
        encodeMessage(type, {
          risk_id: result.risk_id, severity: args.severity, action: args.action,
          ...(args.scenario !== undefined ? { scenario: args.scenario } : {}),
        }), exec);
      return { ...result, escalated: isP0 };
    },
  }));
}

function requireArg(value, name) {
  if (value === undefined || String(value).trim() === '') {
    throw new Error(`"${name}" is required for this risk action`);
  }
  return value;
}
