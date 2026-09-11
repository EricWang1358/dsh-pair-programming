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
import { taskWorkspace } from '../runtime/workspace-context.js';
import { knownDisclosureRefs, dispositionError, disclosureSubjectTask, isBookkeepingRuling } from '../protocol/disclosure.js';
import { teamLockKey } from '../state/layout.js';
import { readTeam, writeTeam, recordGatePass } from '../state/store.js';
import { encodeMessage } from '../protocol/messages.js';
import { gateStateFingerprint, reviewStateFingerprint, runGate, isSupersededRejectedCycle, isSupersededCheckpoint, gateBindingRecord, gateBindingDiff } from '../protocol/gate.js';
import { blocksVerification } from '../protocol/risks.js';
import { readCeLoads, taskWindowStart, writeLaneViolation } from '../integrations/ce-ledger.js';
import { namesTask, planBudgetExhausted, specFrozen, advancePhase } from '../protocol/machine.js';
import { runDodCommand, checkDeliverables, checkScope } from './gate-exec.js';
import { digestOracleFiles, runOracleCommand } from './oracle-exec.js';
import { resolveCycleOracle } from '../protocol/oracle.js';
import { EvidenceCache } from '../state/evidence-cache.js';
import { createHash, randomUUID } from 'node:crypto';
import { captureEvidenceBoundary, assertEvidenceBoundary, requireProductRun } from './verification-boundary.js';

/**
 * Why a review binding stopped binding, per dimension.
 *
 * Measured: GATE_STALE said only that "the latest final review does not bind
 * the current candidate, board and task attempt", and the captain spent five
 * source-reading sessions establishing WHICH input had moved. The three
 * dimensions are compared separately here — attempt identity, candidate
 * worktree, judged board — and the board dimension is itemised with ids by
 * gateBindingDiff. When no line can be produced, this says so instead of
 * guessing: a fabricated diff is worse than none, because it sends the
 * captain to the wrong input.
 */
function bindingDetail(binding, task, boundary, diff, recordable) {
  const moved = [];
  if (binding?.assignee !== (task.assignee ?? null) || binding?.attemptId !== (task.attemptId ?? null)
    || binding?.handoffId !== (task.handoffId ?? null)) {
    moved.push(`task attempt: reviewed ${binding?.assignee ?? 'none'}/${binding?.attemptId ?? 'none'}, live ${task.assignee ?? 'none'}/${task.attemptId ?? 'none'}`);
  }
  if (typeof binding?.worktreeSha === 'string' && binding.worktreeSha !== boundary.worktreeSha) {
    moved.push(`candidate worktree: reviewed ${binding.worktreeSha.slice(0, 12)}, now ${boundary.worktreeSha.slice(0, 12)}`);
  }
  moved.push(...diff);
  if (moved.length === 0) {
    return recordable !== true
      ? ' This credential carries no per-input breakdown (it predates it), so the input that moved cannot be named here; the next gate pass stores one and a later refusal will name it.'
      : '';
  }
  return ` Changed since the credential this task holds: ${moved.join('; ')}.`;
}

export function registerArbitrateTools(ctx, config, runtime) {
  /* pair_arbitrate ------------------------------------------------------ */
  ctx.tools.register(defineTool({
    name: 'pair_arbitrate',
description: 'Captain only: resolve a conflict (Driver/Navigator disagreement, a contested risk, or an approach decision) on repository evidence. A ruling attributable to one task spends that task\'s planning budget (planningMaxArbitrations); a task that already has cycles is exempt, and a ruling that names no task falls back to the currently claimed task budget rather than costing nothing (the loophole that let a captain write ~18 rulings against a 2/task cap by omitting task ids), and record the decision with rationale. Closing a declared disclosure is bookkeeping, not a new dispute: it is never refused by the planning budget and never charged — unless the ruling also decides something else (it names another task, or you pass new_dispute), in which case it is billed as a new dispute. Apply the 70% rule: for reversible decisions, strong (not perfect) evidence is the bar — waiting for certainty costs more than a cheap correction. Notifies the whole team.',
    parameters: {
      conflict_ref: { type: 'string', required: true, description: 'What is being decided (cycle id, risk id, or "plan").' },
      decision: { type: 'string', required: true, description: 'The chosen path.' },
      evidence: { type: 'array', items: { type: 'string' }, required: true, description: 'Repository evidence backing the choice.' },
      rationale: { type: 'string', required: true, description: 'Why this path; what is salvageable from the rejected option.' },
      task_id: { type: 'string', description: 'The task this decision belongs to, if any.' },
      closes_disclosure: { type: 'string', description: 'The ref of one declared blind spot this ruling settles (see pair_status "Open disclosures"), e.g. cycle:c-t-4-1-9:tuned or oracle:t-8:non-gating. A successful pair_stop is refused while any disclosure is unclaimed — shipping with a known gap is allowed, shipping without anyone deciding to is not.' },
      disposition: { type: 'string', description: 'Required with closes_disclosure: what actually happened to the gap. "fixed" (it is gone, and evidence shows it) | "accepted" (it ships as-is, knowingly) | "deferred" (postponed to named later work).' },
      sink: { type: 'string', description: 'Required for disposition accepted|deferred: where the residual now durably lives — board | issue | document | pr.' },
      sink_ref: { type: 'string', description: 'Required for disposition accepted|deferred: the traceable reference inside that sink (a task id, issue number, document path, PR url). A gap accepted "as backlog" with no backlog entry is refused.' },
      new_dispute: { type: 'boolean', description: 'Declare that this ruling ALSO decides a new dispute, so it spends the planning arbitration budget like any other. It can only add a charge, never remove one: a ruling that closes a disclosure and names another task is billed as a new dispute already.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Decision ${v.decision_id} recorded for ${v.conflict_ref}.` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const stateRoot = stateRootFor(agent, config);
      const team = await requireParticipantTeam(agent, config);
      if (!isCaptain(team, agent)) throw new Error('only the captain can arbitrate');
      const decisionId = `d-${randomUUID().slice(0, 8)}`;
      // The rule the tool applied, reported back so the caller does not have to
      // infer it from the board.
      let billing = 'dispute';
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        // Attribute a ruling to the task it is about — including one whose
        // conflict_ref carefully avoids the task id. The measured loophole: a
        // captain wrote 'the composition card' and 'the band card' instead of
        // 't-6' and 't-7' precisely because the tool had already refused to
        // spend the budget; the total came to ~18 rulings against a 2/task cap.
        // Attribution order: (1) the task_id the captain declared, (2) any
        // pending or in-flight task named by conflict_ref, (3) the task the
        // calling seat is working right now. That last hop closes the door.
        //
        // Declaration comes first because the lookup used to OR the two
        // together and let array order decide: on a board where t-1 is first, a
        // ruling that explicitly named t-2 was still billed to t-1 whenever its
        // ref mentioned t-1. Measured (SG-career): closing a disclosure owned
        // by t-1 was refused with 'task "t-1" used 2 of 2' even when the caller
        // passed task_id 't-2'.
        const declared = args.task_id === undefined
          ? undefined
          : fresh.tasks.find(task => task.status !== 'cancelled' && task.id === args.task_id);
        const claimed = fresh.tasks.find(t => (t.status === 'claimed' || t.status === 'in_progress') && t.assignee !== undefined);
        const planned = declared
          ?? fresh.tasks.find(t => t.status !== 'cancelled' && namesTask(args.conflict_ref, t.id))
          ?? claimed;
        // Closing a blind spot must name one that exists. A ruling that closes
        // a typo would read as settled on the board and gate nothing, which is
        // the failure this whole mechanism exists to stop.
        const closes = String(args.closes_disclosure ?? '').trim();
        const disposition = String(args.disposition ?? '').trim();
        const sink = String(args.sink ?? '').trim();
        const sinkRef = String(args.sink_ref ?? '').trim();
        // BILLING: is this ruling a new dispute, or the board's own paperwork?
        //
        // A ruling that closes a declared disclosure is bookkeeping. The board
        // refuses a successful stop while any disclosure is unclaimed, so that
        // ruling is an obligation the protocol imposes rather than a new
        // dispute, and charging it to the subject task's planning budget made
        // the board's own requirement unaffordable: measured, five refusals of
        // 'task "t-1" used 2 of 2 planning arbitrations … spec is not frozen
        // yet', and the gap became closable only once another Driver opened a
        // cycle and the task left planning. So it is neither refused nor
        // charged, and the record says which rule was applied (billing:
        // 'bookkeeping', no chargedTo) — pair_status prints it in the residual
        // ledger.
        //
        // It IS a new dispute, billed exactly as before, when it decides
        // something beyond that gap: it names another task (a ruling's task_id
        // declares the ruling belongs to that task), or the captain declares
        // one with new_dispute. That flag can only add a charge, never remove
        // one, so it is an honesty channel rather than a bypass.
        const subjectTask = closes === '' ? undefined : disclosureSubjectTask(fresh, closes);
        const bookkeeping = closes !== '' && args.new_dispute !== true
          && (subjectTask === undefined ? planned === undefined : planned?.id === subjectTask);
        billing = bookkeeping ? 'bookkeeping' : 'dispute';
        if (!bookkeeping && planned !== undefined && specFrozen(fresh.protocol, planned.id) === false) {
          // This allowance counts NEW DISPUTES. machine.planningArbitrationsUsed
          // counts every attributed ruling, so the rulings that discharged a
          // declared gap are hidden from the view this tool enforces on; that
          // predicate is where the rule belongs durably.
          const debatable = {
            ...fresh.protocol,
            decisions: fresh.protocol.decisions.filter(decision => !isBookkeepingRuling(decision)),
          };
          const budget = planBudgetExhausted(debatable, planned.id, config.planningMaxArbitrations ?? 2);
          if (budget.exhausted) throw new Error(budget.refusal);
        }
        // Every ruling now carries which task the budget charged, so the audit
        // trail says what the tool actually did rather than what the ref happens
        // to spell. A bookkeeping ruling charges nobody.
        const chargedTo = bookkeeping ? undefined : planned?.id;
        if (closes !== '') {
          const refs = knownDisclosureRefs(fresh);
          if (!refs.includes(closes)) {
            throw new Error(`no declared disclosure has the ref "${closes}" — pair_status lists the open ones under "Open disclosures"${refs.length > 0 ? ` (this board has: ${refs.join(', ')})` : ' (this board has none)'}`);
          }
          // V5.2: closing a gap is not the same as treating it. A ruling must
          // say which of the three things it did, and anything that leaves a
          // residual must name the durable place that residual now lives.
          const bad = dispositionError({ disposition, sink, sinkRef });
          if (bad !== undefined) throw new Error(bad);
        }
        fresh.protocol.decisions.push({
          id: decisionId, conflictRef: args.conflict_ref, decision: args.decision,
          evidence: args.evidence, rationale: args.rationale, taskId: args.task_id, billing,
          ...(closes === '' ? {} : { closesDisclosure: closes, disposition }),
          ...(closes !== '' && sink !== '' ? { sink } : {}),
          ...(closes !== '' && sinkRef !== '' ? { sinkRef } : {}),
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
      return {
        decision_id: decisionId,
        conflict_ref: args.conflict_ref,
        billing,
        ...(String(args.closes_disclosure ?? '').trim() === '' ? {} : {
          closes_disclosure: String(args.closes_disclosure).trim(),
          disposition: String(args.disposition ?? '').trim(),
          ...(String(args.sink ?? '').trim() === '' ? {} : { sink: String(args.sink).trim() }),
          ...(String(args.sink_ref ?? '').trim() === '' ? {} : { sink_ref: String(args.sink_ref).trim() }),
        }),
      };
    },
  }));

  /* pair_gate_check ----------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_gate_check',
    description: 'Run the completion quality gate for one task: every relevant cycle settled, the latest cycle has a final ACCEPT bound to the current candidate and board, no open P0/P1 risks, all arbitrations documented, and — when the task carries a frozen oracle — the gate REPLAYS that oracle itself (digest recomputed, command re-run). The pass is bound to the worktree and relevant board state; an identical replay reuses the same gate_pass_id, while a material change makes it stale.',
    parameters: { task_id: { type: 'string', required: true, description: 'The task to gate-check.' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v.pass ? `Gate PASS for ${v.task_id} (gate_pass_id ${v.gate_pass_id}).` : `Gate FAIL for ${v.task_id}:\n- ${v.failures.join('\n- ')}` }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const stateRoot = stateRootFor(agent, config);
      const team = await requireParticipantTeam(agent, config);
      const workspace = taskWorkspace(team, args.task_id, workspaceOf(agent), { closure: true });
      const untrusted = blocksVerification(team.protocol, args.task_id);
      if (untrusted.length > 0) {
        throw new Error(`open P0 risk(s) make a gate pass untrustworthy: ${untrusted.map(r => `${r.id}(${r.scope ?? 'product'})`).join(', ')} — the gate replays the oracle, so an instrument P0 is exactly a reason not to believe its result yet.`);
      }
      const cache = new EvidenceCache(stateRoot, config.evidenceCache ?? true, team.protocol.stats, ctx.logger.warn);
      const boundary = await captureEvidenceBoundary(team, args.task_id, agent, config, exec.signal, { closure: true });
      const reviewedTask = team.tasks.find(t => t.id === args.task_id);
      const latestReview = team.protocol.cycles.filter(c => c.taskId === args.task_id && !isSupersededRejectedCycle(c, reviewedTask.oracle)).at(-1)?.verify;
      // Re-certification, and why the worktree is the one dimension that may move.
      // Completing a task binds its credential to the tree of that moment; the
      // NEXT task's implementation moves the tree, so pair_stop finds the older
      // credential stale and tells the captain to re-run this gate. Measured
      // live: with the review binding enforced in every dimension that call is
      // impossible to obey, and no board with two tasks can ever be stopped as
      // complete. So a task ALREADY completed on its own full review and
      // credential may be re-certified against the final tree: board, attempt and
      // reviewer identity must still bind exactly, and the gate re-runs that
      // task's frozen oracle here, which is the executable statement of the
      // contract the review signed. What this does not re-check is an unreviewed
      // edit made after completion that leaves the oracle green — pair_stop's
      // whole-suite green build is the remaining net, and the pass records that
      // it was re-certified rather than freshly reviewed.
      let recertified = false;
      if (latestReview?.verdict === 'accept') {
        const binding = latestReview.binding;
        // What the reviewer actually signed is a candidate and an attempt. The
        // board around it keeps moving after a final ACCEPT — another task
        // lands, the phase reaches RETRO, the captain records a ruling — and
        // measured live, treating every one of those as review drift made the
        // remedy pair_stop prescribes impossible: the captain's own arbitration
        // "t-1 gate stale after t-2 edit" was itself part of t-1's gate
        // fingerprint, so ruling on the stale gate tightened it. Nothing is
        // waived here that is not re-derived below: the gate re-runs the frozen
        // oracle, re-reads scope and deliverables, and re-executes the whole DoD
        // checklist against the CURRENT board, and a new cycle on this task
        // makes latestReview stop being an ACCEPT so all_accepted fails on its
        // own. The attempt identity is the one thing only the review can speak
        // to, so that stays exact, and the credential records which of the two
        // paths issued it.
        const attemptBound = binding?.assignee === (reviewedTask.assignee ?? null)
          && binding?.attemptId === (reviewedTask.attemptId ?? null)
          && binding?.handoffId === (reviewedTask.handoffId ?? null)
          && typeof binding?.worktreeSha === 'string';
        const bindsCurrentCandidate = attemptBound && binding.worktreeSha === boundary.worktreeSha
          && binding.gateStateSha === reviewStateFingerprint(team, args.task_id);
        // A completed task has no attempt left to compare against: the scheduler
        // releases attemptId the moment the task goes terminal, so binding the
        // re-certification to the LIVE task would refuse every completed task
        // for lack of a field completion itself removes. The identity that does
        // survive is the chain review -> the credential this task still holds,
        // both taken while the attempt was live and both naming it.
        // The pointer can be absent while the pass it named is still on the board:
        // a failed gate used to erase task.gatePassId, and a task completed before
        // that rule existed may simply lack it. Falling back to this task's latest
        // pass keeps the chain review -> credential alive, and the pass is the same
        // thing the pointer was pointing at. Measured failure: a completed, fully
        // verified task whose field had been erased could never be re-certified, so
        // pair_status kept promising "Captain may re-certify a completed task" while
        // every pair_gate_check refused it as GATE_STALE.
        const heldPass = team.protocol.gatePasses.find(item => item.id === reviewedTask.gatePassId)
          ?? team.protocol.gatePasses.filter(item => item.taskId === args.task_id).at(-1);
        const held = heldPass?.binding?.taskAttempt;
        const attemptChain = binding !== undefined && held !== undefined && typeof binding.worktreeSha === 'string'
          && binding.assignee === held.assignee && binding.attemptId === held.attemptId && binding.handoffId === held.handoffId;
        recertified = !bindsCurrentCandidate && attemptChain && reviewedTask.status === 'completed';
        if (!bindsCurrentCandidate && !recertified) {
          // The recorded side is the credential this task holds: its last pass
          // stored the inputs it judged. A review binding never carries one —
          // the gate does not write into the cycle record it accepted.
          const heldPass = team.protocol.gatePasses.filter(item => item.taskId === args.task_id).at(-1);
          const recorded = heldPass?.binding?.breakdown === undefined ? binding : heldPass.binding;
          throw new Error(`GATE_STALE: the latest final review does not bind the current candidate, board and task attempt (or predates review binding).${bindingDetail(binding, reviewedTask, boundary, gateBindingDiff(team, args.task_id, recorded), recorded?.breakdown !== undefined)} Preserve the old verdict; open a fresh cycle, report GREEN and obtain a new final review before gating.`);
        }
      }
      const gateCmd = await runDodCommand(config, workspace, cache, stateRoot, { signal: exec.signal });
      if (gateCmd.skipped !== true) requireProductRun(gateCmd, exec.signal);

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
      // Inherited scope: files already blast-radius-reviewed under a COMPLETED
      // task stay review-covered without redeclaration. Write-side enforcement
      // is intentionally NOT here (the tool sees declarations, not mutations):
      // it lives in gate materials as navigator-quoted write-declaration +
      // owner-oracle regression (session rule d-82db3abd/d-b4f7f0f7).
      const inheritedFiles = team.protocol.cycles
        .filter(c => c.taskId !== args.task_id && team.tasks.find(t => t.id === c.taskId)?.status === 'completed')
        .flatMap(c => c.proposal?.files ?? []);
      if (team.parallel) {
        declaredFiles.push(...(gatedTask?.oracle?.files ?? []));
        if (gatedTask?.status === 'completed') {
          inheritedFiles.push(...team.tasks.filter(task => task.status === 'completed').flatMap(task => task.oracle?.files ?? []));
        }
      }
      const candidateOnly = team.parallel && gatedTask?.status !== 'completed';
      const scopeCheck = await checkScope(workspace, declaredFiles, candidateOnly ? { ref: gatedTask.baseHead, dirtyFiles: [] } : team.baseline, candidateOnly ? [] : inheritedFiles);
      const oracle = gatedTask?.oracle;
      let oracleReplay;
      // An old seal needs a matching replacement audit. Historical checkpoints
      // still contribute scope and Test First evidence to the task gate.
      const strayCycle = team.protocol.cycles
        .filter(c => c.taskId === args.task_id && !isSupersededRejectedCycle(c, oracle) && !isSupersededCheckpoint(c, oracle))
        .map(c => resolveCycleOracle(c, gatedTask))
        .find(r => r.error !== undefined);
      if (strayCycle !== undefined) {
        oracleReplay = { ok: false, reason: strayCycle.error };
      } else if (oracle !== undefined) {
        const actualSha = await digestOracleFiles(workspace, oracle.files);
        if (actualSha !== oracle.sha) {
          oracleReplay = { ok: false, reason: `the frozen oracle changed (sealed ${String(oracle.sha).slice(0, 12)}, now ${actualSha.slice(0, 12)}) — its files must not be edited by the work it judges`, sha: actualSha };
        } else {
          // The oracle's own exit-code declaration travels with the replay: without
          // it this one call site formed a different opinion about exit 2 than the
          // freeze, verify and integrate paths, which all read the sealed contract.
          const run = await runOracleCommand(workspace, oracle.cmd, { signal: exec.signal, instrumentExitCodes: oracle.instrumentExitCodes });
          requireProductRun(run, exec.signal);
          oracleReplay = run.exit === 0
            ? { ok: true, sha: actualSha, exit: 0, outputSha: run.outputSha }
            : { ok: false, reason: `the frozen oracle exits ${String(run.exit)}: ${run.outputTail.split(String.fromCharCode(10)).slice(-6).join(' / ')}`, sha: actualSha, exit: run.exit };
        }
      }
      await assertEvidenceBoundary(boundary, await readTeam(stateRoot, team.id), agent, config, exec.signal);
      const worktreeSha = boundary.worktreeSha;
      const result = await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        if (!fresh.tasks.some(t => t.id === args.task_id)) throw new Error(`unknown task "${args.task_id}"`);
        const targetTask = fresh.tasks.find(t => t.id === args.task_id);
        await assertEvidenceBoundary(boundary, fresh, agent, config, exec.signal);
        if (gateCmd.skipped !== true && gateCmd.exit !== 0) {
          if (targetTask !== undefined) delete targetTask.gatePassId;
          fresh.protocol.stats.gateFails = (fresh.protocol.stats.gateFails ?? 0) + 1;
          await writeTeam(stateRoot, fresh);
          return { task_id: args.task_id, pass: false, failures: [`dodCommand "${gateCmd.command}" exited ${gateCmd.exit}:`, gateCmd.outputTail] };
        }
        // V5.3d: read the CE load ledger for this task's window. The plugin
        // never serves a write-lane skill, so anything found here arrived from
        // another skill root and means a second loop touched this worktree.
        const window = taskWindowStart(fresh, args.task_id);
        const ledger = await readCeLoads(stateRoot, window);
        await assertEvidenceBoundary(boundary, fresh, agent, config, exec.signal);
        const outcome = runGate(fresh, args.task_id, {
          tddMode: fresh.tddMode ?? config.tddMode,
          dod: config.dod,
          oracleReplay, deliverableCheck, scopeCheck,
          ceLoads: { ...ledger, violation: writeLaneViolation(ledger.loads) },
        });
        if (!outcome.pass) {
          // Erase the pointer only when the PRODUCT is what failed. Everything else
          // the checklist covers — a moved board, an open blocker, an undocumented
          // ruling, a process rule — is re-derived by the next gate, and most of it
          // moves the gate fingerprint anyway, which pair_task_update already checks.
          // Erasing on those turned one failed attempt into a completed task that
          // could never hold a credential again.
          const productFailure = outcome.checklist?.oracleReplay?.ok === false
            || outcome.checklist?.deliverables?.ok === false;
          if (targetTask !== undefined && productFailure) delete targetTask.gatePassId;
          fresh.protocol.stats.gateFails = (fresh.protocol.stats.gateFails ?? 0) + 1;
          await writeTeam(stateRoot, fresh);
          return { task_id: args.task_id, pass: false, failures: outcome.failures, checklist: outcome.checklist };
        }
        const gateOutputSha = gateCmd.skipped === true
          ? undefined
          : createHash('sha256').update(gateCmd.output ?? '').digest('hex');
        // The credential records the inputs it judged, so the NEXT refusal can
        // name the one that moved instead of sending the captain to read this
        // module for the answer (measured: five source-reading sessions). It
        // rides on the pass — never on the cycle record, which the gate must
        // leave byte-identical to what was accepted — and it is excluded from
        // the digest it describes, so recording it can never invalidate the
        // credential it was recorded for.
        const bindingRecord = gateBindingRecord(fresh, args.task_id);
        const previousPass = fresh.protocol.gatePasses.filter(item => item.taskId === args.task_id).at(-1);
        const pass = recordGatePass(fresh, args.task_id, outcome.checklist, {
          worktreeSha,
          gateStateSha: gateStateFingerprint(fresh, args.task_id),
          ...bindingRecord,
          // Re-certification carries the original attempt forward: it still
          // attests the same reviewed attempt, and copying the emptied live
          // fields would break the chain for the NEXT re-certification.
          taskAttempt: recertified
            ? (fresh.protocol.gatePasses.find(item => item.id === targetTask.gatePassId)?.binding?.taskAttempt
              ?? { assignee: targetTask.assignee ?? null, attemptId: targetTask.attemptId ?? null, handoffId: targetTask.handoffId ?? null })
            : { assignee: targetTask.assignee ?? null, attemptId: targetTask.attemptId ?? null, handoffId: targetTask.handoffId ?? null },
          ...(oracleReplay === undefined ? {} : { oracleSha: oracleReplay.sha }),
          ...(gateCmd.skipped === true ? {} : { gateCommand: gateCmd.command, gateExit: gateCmd.exit, gateOutputSha }),
        });
        const credentialReused = previousPass?.id === pass.id;
        if (recertified) pass.recertified = true;
        if (oracleReplay !== undefined) {
          pass.oracleSha = oracleReplay.sha;
          pass.oracleExit = oracleReplay.exit;
          pass.oracleOutputSha = oracleReplay.outputSha;
        }
        if (gateCmd.skipped !== true && pass.command === undefined) {
          pass.command = gateCmd.command;
          pass.exit = gateCmd.exit;
          pass.outputSha = gateOutputSha;
          pass.cached = gateCmd.cached === true;
        }
        // The task carries the authoritative current credential immediately.
        // Completion promotes no hidden seat-local id; pair_status can show
        // this binding before the caller performs pair_task_update.
        if (targetTask !== undefined) targetTask.gatePassId = pass.id;
        await writeTeam(stateRoot, fresh);
        return { task_id: args.task_id, pass: true, gate_pass_id: pass.id, credential_reused: credentialReused, checklist: outcome.checklist, deliverables: deliverableCheck, scope: scopeCheck ?? null, ...(oracleReplay === undefined ? {} : { oracle_replay: oracleReplay }) };
      });
      // Native isolated seats do not forward their final reply to the captain.
      // A newly gated candidate therefore needs its own durable integration
      // edge. Keep delivery outside the board lock, and do not turn identical
      // gate replays or final-tree re-certification into another review round.
      if (team.parallel && result.pass && !result.credential_reused) {
        const current = await readTeam(stateRoot, team.id);
        const task = current?.tasks.find(t => t.id === args.task_id);
        if (task && ['claimed', 'in_progress'].includes(task.status)
          && task.gatePassId === result.gate_pass_id
          && current.parallel?.integrations?.[task.id]?.candidate?.gatePassId !== result.gate_pass_id) {
          await deliverProtocolMessage(ctx, config, agent, current, 'captain', encodeMessage('GATE_PASS', {
            task_id: task.id, gate_pass_id: result.gate_pass_id, workspace: task.workspace,
            next: 'Run pair_integrate for this candidate; its owning Driver completes only after integration passes.',
          }), exec);
          await runtime.scheduler.kickTeam(workspaceOf(agent), team.id, undefined).catch(() => undefined);
        }
      }
      return result;
    },
  }));
}
