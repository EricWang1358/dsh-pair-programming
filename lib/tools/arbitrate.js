/**
 * Arbitration & gate tools: pair_arbitrate (captain's evidence-based decision
 * log) and pair_gate_check (the hard quality gate that issues the
 * gate_pass_id required by pair_task_update).
 *
 * @module dsh-pair-programming/tools/arbitrate
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { withLock } from '../state/lock.js';
import { stateRootFor, workspaceOf, requireAgent, requireParticipantTeam, deliverProtocolMessage, isCaptain } from './shared.js';
import { teamLockKey } from '../state/layout.js';
import { readTeam, writeTeam, recordGatePass } from '../state/store.js';
import { encodeMessage } from '../protocol/messages.js';
import { runGate } from '../protocol/gate.js';
import { blocksVerification } from '../protocol/risks.js';
import { namesTask, planBudgetExhausted, specFrozen, advancePhase } from '../protocol/machine.js';
import { runDodCommand, checkDeliverables, checkScope } from './gate-exec.js';
import { digestOracleFiles, runOracleCommand, workspaceFingerprint } from './oracle-exec.js';
import { resolveCycleOracle } from '../protocol/oracle.js';
import { EvidenceCache } from '../state/evidence-cache.js';
import { createHash, randomUUID } from 'node:crypto';

export function registerArbitrateTools(ctx, config, runtime) {
  /* pair_arbitrate ------------------------------------------------------ */
  ctx.tools.register(defineTool({
    name: 'pair_arbitrate',
description: 'Captain only: resolve a conflict (Driver/Navigator disagreement, a contested risk, or an approach decision) on repository evidence. A ruling attributable to one task spends that task\'s planning budget (planningMaxArbitrations); a task that already has cycles is exempt, and a ruling that names no task falls back to the currently claimed task budget rather than costing nothing (the loophole that let a captain write ~18 rulings against a 2/task cap by omitting task ids), and record the decision with rationale. Apply the 70% rule: for reversible decisions, strong (not perfect) evidence is the bar — waiting for certainty costs more than a cheap correction. Notifies the whole team.',
    parameters: {
      conflict_ref: { type: 'string', required: true, description: 'What is being decided (cycle id, risk id, or "plan").' },
      decision: { type: 'string', required: true, description: 'The chosen path.' },
      evidence: { type: 'array', items: { type: 'string' }, required: true, description: 'Repository evidence backing the choice.' },
      rationale: { type: 'string', required: true, description: 'Why this path; what is salvageable from the rejected option.' },
      task_id: { type: 'string', description: 'The task this decision belongs to, if any.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Decision ${v.decision_id} recorded for ${v.conflict_ref}.` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const stateRoot = stateRootFor(agent, config);
      const team = await requireParticipantTeam(agent, config);
      if (!isCaptain(team, agent)) throw new Error('only the captain can arbitrate');
      const decisionId = `d-${randomUUID().slice(0, 8)}`;
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        // Attribute a ruling to the task it is about — including one whose
        // conflict_ref carefully avoids the task id. The measured loophole: a
        // captain wrote 'the composition card' and 'the band card' instead of
        // 't-6' and 't-7' precisely because the tool had already refused to
        // spend the budget; the total came to ~18 rulings against a 2/task cap.
        // Fallback attribution: (1) an explicit task_id, (2) any pending or in-
        // flight task named by conflict_ref, (3) the task the calling seat is
        // working right now. That last hop closes the door.
        const claimed = fresh.tasks.find(t => (t.status === 'claimed' || t.status === 'in_progress') && t.assignee !== undefined);
        const planned = fresh.tasks.find(t => t.status !== 'cancelled' && (args.task_id === t.id || namesTask(args.conflict_ref, t.id)))
          ?? claimed;
        if (planned !== undefined && specFrozen(fresh.protocol, planned.id) === false) {
          const budget = planBudgetExhausted(fresh.protocol, planned.id, config.planningMaxArbitrations ?? 2);
          if (budget.exhausted) throw new Error(budget.refusal);
        }
        // Every ruling now carries which task the budget charged, so the audit
        // trail says what the tool actually did rather than what the ref happens
        // to spell.
        const chargedTo = planned?.id;
        fresh.protocol.decisions.push({
          id: decisionId, conflictRef: args.conflict_ref, decision: args.decision,
          evidence: args.evidence, rationale: args.rationale, taskId: args.task_id,
          ...(chargedTo !== undefined && chargedTo !== args.task_id ? { chargedTo } : {}),
          at: Date.now(),
        });
        await writeTeam(stateRoot, fresh);
      });
      const body = encodeMessage('ARBITRATE', {
        conflict_ref: args.conflict_ref, decision: args.decision,
        evidence: args.evidence, rationale: args.rationale,
      });
      for (const member of team.members.filter(m => m.status !== 'removed')) {
        await deliverProtocolMessage(ctx, config, agent, team, member.name, body, exec);
      }
      return { decision_id: decisionId, conflict_ref: args.conflict_ref };
    },
  }));

  /* pair_gate_check ----------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_gate_check',
    description: 'Run the completion quality gate for one task: every cycle ACCEPTed, no open P0/P1 risks, all arbitrations documented, and — when the task carries a frozen oracle — the gate REPLAYS that oracle itself (digest recomputed, command re-run) instead of trusting any claim about it. On pass, issues the gate_pass_id that pair_task_update(status=completed) requires.',
    parameters: { task_id: { type: 'string', required: true, description: 'The task to gate-check.' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v.pass ? `Gate PASS for ${v.task_id} (gate_pass_id ${v.gate_pass_id}).` : `Gate FAIL for ${v.task_id}:\n- ${v.failures.join('\n- ')}` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const stateRoot = stateRootFor(agent, config);
      const team = await requireParticipantTeam(agent, config);
      const workspace = workspaceOf(agent);
      const untrusted = blocksVerification(team.protocol);
      if (untrusted.length > 0) {
        throw new Error(`open P0 risk(s) make a gate pass untrustworthy: ${untrusted.map(r => `${r.id}(${r.scope ?? 'product'})`).join(', ')} — the gate replays the oracle, so an instrument P0 is exactly a reason not to believe its result yet.`);
      }
      const cache = new EvidenceCache(stateRoot, config.evidenceCache ?? true, team.protocol.stats, ctx.logger.warn);
      const gateCmd = await runDodCommand(config, workspace, cache, stateRoot);

      // N4: the gate re-runs the frozen oracle rather than counting evidence
      // strings. This is the check v2 did not have — `evidence.length > 0`
      // passed on both instances the pair arm shipped broken.
      const gatedTask = team.tasks.find(t => t.id === args.task_id);
      // Did the ordered artifacts get handed over, and did the change stay
      // inside the files a proposal declared? Both ask about the RESULT; every
      // other checklist item asks about the process, which is how a task once
      // passed this gate with its own named deliverables never written.
      const deliverableCheck = await checkDeliverables(workspace, gatedTask?.deliverables);
      const declaredFiles = team.protocol.cycles
        .filter(c => c.taskId === args.task_id)
        .flatMap(c => c.proposal?.files ?? []);
      const scopeCheck = await checkScope(workspace, declaredFiles, team.baseline);
      const oracle = gatedTask?.oracle;
      let oracleReplay;
      // Every cycle of this task must have been judged against the seal the
      // task still carries; a re-fork mid-task is a split brain, not a pass.
      // 2026-02 repair: only work still AWAITING a verdict can be a split
      // brain. A judged cycle was measured against its own seal — after a
      // legitimate defect re-fork mid-task, keeping judged cycles in this
      // check would poison every later gate for the task (the old stamp can
      // never match the new oracle again).
      const strayCycle = team.protocol.cycles
        .filter(c => c.taskId === args.task_id && c.verify === undefined)
        .map(c => resolveCycleOracle(c, gatedTask))
        .find(r => r.error !== undefined);
      if (strayCycle !== undefined) {
        oracleReplay = { ok: false, reason: strayCycle.error };
      } else if (oracle !== undefined) {
        const actualSha = await digestOracleFiles(workspace, oracle.files);
        if (actualSha !== oracle.sha) {
          oracleReplay = { ok: false, reason: `the frozen oracle changed (sealed ${String(oracle.sha).slice(0, 12)}, now ${actualSha.slice(0, 12)}) — its files must not be edited by the work it judges`, sha: actualSha };
        } else {
          const run = await runOracleCommand(workspace, oracle.cmd);
          oracleReplay = run.exit === 0
            ? { ok: true, sha: actualSha, exit: 0, outputSha: run.outputSha }
            : { ok: false, reason: `the frozen oracle exits ${String(run.exit)}: ${run.outputTail.split(String.fromCharCode(10)).slice(-6).join(' / ')}`, sha: actualSha, exit: run.exit };
        }
      }
      // Capture this only after every gate command and oracle replay: a pass
      // credential must describe the exact tree that produced it, not a tree
      // from before a test hook or formatter changed files.
      const worktreeSha = await workspaceFingerprint(workspace, { stateDir: config.stateDir });
      return withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        if (!fresh.tasks.some(t => t.id === args.task_id)) throw new Error(`unknown task "${args.task_id}"`);
        if (gateCmd.skipped !== true && gateCmd.exit !== 0) {
          fresh.protocol.stats.gateFails = (fresh.protocol.stats.gateFails ?? 0) + 1;
          await writeTeam(stateRoot, fresh);
          return { task_id: args.task_id, pass: false, failures: [`dodCommand "${gateCmd.command}" exited ${gateCmd.exit}:`, gateCmd.outputTail] };
        }
        const outcome = runGate(fresh, args.task_id, {
          tddMode: fresh.tddMode ?? config.tddMode,
          dod: config.dod,
          oracleReplay, deliverableCheck, scopeCheck,
        });
        if (!outcome.pass) {
          fresh.protocol.stats.gateFails = (fresh.protocol.stats.gateFails ?? 0) + 1;
          await writeTeam(stateRoot, fresh);
          return { task_id: args.task_id, pass: false, failures: outcome.failures, checklist: outcome.checklist };
        }
        const pass = recordGatePass(fresh, args.task_id, outcome.checklist, {
          worktreeSha,
          ...(oracleReplay === undefined ? {} : { oracleSha: oracleReplay.sha }),
        });
        if (oracleReplay !== undefined) {
          pass.oracleSha = oracleReplay.sha;
          pass.oracleExit = oracleReplay.exit;
          pass.oracleOutputSha = oracleReplay.outputSha;
        }
        if (gateCmd.skipped !== true) {
          pass.command = gateCmd.command;
          pass.exit = gateCmd.exit;
          pass.outputSha = createHash('sha256').update(gateCmd.output ?? '').digest('hex');
          pass.cached = gateCmd.cached === true;
        }
        await writeTeam(stateRoot, fresh);
        return { task_id: args.task_id, pass: true, gate_pass_id: pass.id, checklist: outcome.checklist, deliverables: deliverableCheck, scope: scopeCheck ?? null, ...(oracleReplay === undefined ? {} : { oracle_replay: oracleReplay }) };
      });
    },
  }));
}
