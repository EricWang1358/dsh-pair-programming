/**
 * Credential freshness is an invalidation MATRIX, not "the board moved at all".
 *
 * Measured failure (SG-career dual-driver session, 2026-09-10): two GATE_STALE
 * refusals in one session, each bought back with a reopened cycle and a fresh
 * final ACCEPT — three cycles that changed no product byte. The writes that
 * tripped them were the rulings the board itself demands (`d-1b044190`,
 * `d-5772aca2`, recorded to close disclosures of the very cycle they then
 * invalidated) and an amend of an UNRELATED card. Bookkeeping that exists to
 * satisfy the board negated the verdict it was serving.
 *
 * So this suite is the matrix. Left column: writes that cannot change what was
 * accepted and must leave a credential bound. Right column: writes that can,
 * and must still invalidate it.
 *
 * The sibling-amend column is why `taskDesignContext` is exercised here: it is
 * the only place another card could reach this task's fingerprint, so the
 * probe below pins what it actually carries (this task's own criteria and the
 * use-case design it implements) and proves the sibling's card is not in it.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateStateFingerprint, gateStateBreakdown, gateStateIndex, gateBindingDiff, reviewStateFingerprint } from '../lib/protocol/gate.js';
import { initialProtocolState } from '../lib/protocol/machine.js';
import { taskDesignContext } from '../lib/protocol/design.js';
import { registerArbitrateTools } from '../lib/tools/arbitrate.js';
import { registerLifecycleTools } from '../lib/tools/lifecycle.js';
import { createTeamDir, readTeam, writeTeam } from '../lib/state/store.js';
import { closeRisk, mitigateRisk } from '../lib/protocol/risks.js';
import { digestOracleFiles, workspaceFingerprint } from '../lib/tools/oracle-exec.js';

/**
 * One card mid-flight behind a final ACCEPT, beside a second, unrelated card.
 * The review binding is real (the review-excluded fingerprint), so the board
 * can be gated for real in the handler tests below.
 */
export function credentialBoard(over = {}) {
  const board = {
    id: 'fresh', name: 'Fresh', goal: 'ship the credential fix', mode: 'light', captainSessionId: 'cap',
    createdAt: 1, updatedAt: 1, members: [], taskSeq: 2, evidenceStats: { cacheHits: 0, cacheMiss: 0 },
    useCases: [{
      id: 'UC-1', actor: 'maintainer', intent: 'change the plugin', outcome: 'ship verified behavior',
      acceptanceCriteria: [{ id: 'UC-1.AC-1', text: 'the requested behavior passes' }, { id: 'UC-1.AC-2', text: 'existing behavior stays green' }],
      design: {
        responsibility: 'own the credential', approach: 'digest the inputs the gate judges',
        invariants: ['one credential per candidate'], failureBehavior: 'refuse and name the input that moved',
        tradeoffs: 'a narrower payload risks missing an input',
      },
    }],
    tasks: [
      { id: 't-1', subject: 'first card', story: { role: 'maintainer', intent: 'change the plugin', benefit: 'ship verified behavior', acceptance_criteria: ['the requested behavior passes'] },
        status: 'in_progress', assignee: 'driver', attemptId: 'a-1', acceptanceRefs: ['UC-1.AC-1'], dependencies: [], deliverables: [], revision: 1, createdAt: 1, updatedAt: 1 },
      { id: 't-2', subject: 'second card', story: { role: 'maintainer', intent: 'change the docs', benefit: 'readers stop guessing', acceptance_criteria: ['existing behavior stays green'] },
        status: 'pending', acceptanceRefs: ['UC-1.AC-2'], dependencies: [], deliverables: [], revision: 1, createdAt: 1, updatedAt: 1 },
    ],
    protocol: {
      ...initialProtocolState(), phase: 'CYCLING',
      cycles: [{
        id: 'c-t-1-1-1', taskId: 't-1', step: 'VERIFIED', openedAt: 5,
        report: { deviations: 'dropped the legacy shim' },
        verify: { verdict: 'accept', computed: true, evidence: ['node oracle.mjs: 0'], binding: { worktreeSha: 'tree-a', assignee: 'driver', attemptId: 'a-1', handoffId: null } },
      }],
    },
    ...over,
  };
  board.protocol.cycles[0].verify.binding.gateStateSha = reviewStateFingerprint(board, 't-1');
  return board;
}

/** Register pair_arbitrate + pair_gate_check against a mock ctx over `root`. */
function harness(root, stateDir = 'state') {
  const defs = [];
  const ctx = {
    logger: { warn() {}, debug() {}, error() {} }, tools: { register: def => defs.push(def) },
    agents: { get: () => undefined }, subagents: { sendMessage: async () => 'm-1', interrupt() {} },
  };
  const config = { stateDir, planningMaxArbitrations: 2, greenBuildOnStop: false };
  registerArbitrateTools(ctx, config, { scheduler: {} });
  registerLifecycleTools(ctx, config, { selections: {}, scheduler: {} });
  return { tool: name => defs.find(def => def.name === name).execute, captain: { id: 'cap', session: { header: { cwd: root }, append() {} } }, stateRoot: join(root, stateDir) };
}

const fails = fn => fn().then(() => '', error => String(error?.message ?? error));

export async function run(check) {
  /* ---------------------------------------------------------------------- */
  /* The matrix, at the fingerprint the credential is bound to.              */
  /* ---------------------------------------------------------------------- */
  const bound = gateStateFingerprint(credentialBoard(), 't-1');
  const moved = fn => { const board = credentialBoard(); fn(board); return gateStateFingerprint(board, 't-1') !== bound; };

  // The exact writes pair_task_amend makes to ANOTHER card. Measured live as a
  // GATE_STALE trigger for a task that was not amended.
  check(!moved(board => {
    const other = board.tasks[1];
    other.subject = 'second card, reworded';
    other.story.intent = 'change the docs differently';
    other.deliverables = ['out/b.md'];
    other.revision = 2;
    other.updatedAt = 9;
    other.amendments = [{ revision: 2, reason: 'stale wording', changedFields: ['subject'], by: 'captain', at: 9 }];
    delete other.gatePassId;
  }), 'an amend of an unrelated card leaves this task\'s credential bound (it is not this task\'s contract)');
  check(!moved(board => { board.tasks[1].status = 'completed'; }), 'another card landing does not invalidate this card\'s credential');
  check(!moved(board => { board.protocol.decisions = [{ id: 'd-other', taskId: 't-2', conflictRef: 'plan t-2', decision: 'x', rationale: 'r', at: 6 }]; }), 'a ruling attributed to another task is not an input of this task\'s gate');
  check(!moved(board => { board.protocol.risks = [{ id: 'r-style', severity: 'P2', status: 'OPEN', scenario: 's', openedAt: 6 }]; }), 'a P2 backlog item never blocks the gate, so it never stales a credential');
  check(!moved(board => { board.protocol.phase = 'RETRO'; }), 'a phase move is not part of the credential');
  check(!moved(board => { board.tasks[0].updatedAt = 99; board.tasks[0].status = 'in_progress'; }), 'volatile card fields (timestamps, live status) are excluded');
  // The credential records its own inputs. Recording them must not feed them,
  // or every gate pass would invalidate the review binding it just verified.
  check(!moved(board => { board.protocol.cycles[0].verify.binding.breakdown = { task: 'a'.repeat(64) }; }), 'a stored input breakdown is excluded from the digest it describes');

  check(moved(board => { board.protocol.risks = [{ id: 'r-leak', severity: 'P1', status: 'OPEN', scenario: 's', openedAt: 6 }]; }), 'a new P1 blocker still invalidates the credential');

  // #131: the register is hashed as a set of TICKETS, so resolving one is the
  // remedy the credential was waiting for while raising one still moves it.
  const withRisk = credentialBoard();
  withRisk.protocol.risks = [{ id: 'r-leak', severity: 'P1', status: 'OPEN', scenario: 's', trigger: 't', suggestion: 'x', raisedBy: 'challenger', scope: 'product', openedAt: 6 }];
  const openPrint = gateStateFingerprint(withRisk, 't-1');
  const lifecycle = (status, extra) => { const board = credentialBoard(); board.protocol.risks = [{ ...withRisk.protocol.risks[0], status, ...extra }]; return gateStateFingerprint(board, 't-1'); };
  check(lifecycle('CLOSED', { closedAt: 9, closeEvidence: 'node oracle.mjs: 0', closingArtifact: { cmd: 'node oracle.mjs', exit: 0, paths: ['oracle.mjs'] } }) === openPrint,
    '#131 closing the blocker does not move the credential: the ticket is bound, its lifecycle is not');
  check(lifecycle('WONTFIX', { closedAt: 9, wontfixRationale: 'cannot happen in this deployment' }) === openPrint,
    '#131 and neither does a captain ruling it a false alarm');
  check(lifecycle('MITIGATED', { mitigatedAt: 8, mitigationEvidence: 'fixed in gate.js' }) === openPrint,
    '#131 nor the Driver mitigating it (MITIGATED still blocks, so the gate re-judges that state live)');
  const lifecycledAgain = credentialBoard();
  lifecycledAgain.protocol.risks = [{ ...withRisk.protocol.risks[0], confirmedBy: 'navigator', confirmationNote: 'looks fine', reopenedAt: 11 }];
  check(gateStateFingerprint(lifecycledAgain, 't-1') === openPrint,
    '#131 and a lifecycle field added to the ticket later cannot reintroduce the invalidation (the binding is an allowlist)');
  const rewordedRisk = credentialBoard();
  rewordedRisk.protocol.risks = [{ ...withRisk.protocol.risks[0], scenario: 'a different failure mode' }];
  check(gateStateFingerprint(rewordedRisk, 't-1') !== openPrint, '#131 but a reworded blocker still moves it: the ticket itself is what is bound');
  check(moved(board => { board.tasks[0].acceptanceRefs = ['UC-1.AC-1', 'UC-1.AC-2']; }), 'a requirement/acceptance change still invalidates the credential');
  check(moved(board => { board.tasks[0].story.intent = 'change the plugin differently'; }), 'a change to the card\'s own contract still invalidates the credential');
  check(moved(board => { board.useCases[0].design.failureBehavior = 'refuse silently'; }), 'a public-contract (design) change still invalidates the credential');
  check(moved(board => { board.protocol.cycles.push({ id: 'c-t-1-2-2', taskId: 't-1', step: 'PROPOSED', openedAt: 9 }); }), 'a new cycle on this task still invalidates the credential');
  check(moved(board => { board.protocol.cycles[0].verify.verdict = 'reject'; }), 'a rewritten verdict on this task still invalidates the credential');

  // Why the sibling column holds: the only path from another card into this
  // task's digest is taskDesignContext, and it carries this task's OWN criteria
  // plus the use-case design it implements. A sibling allocation change cannot
  // reach it, because acceptanceRefs select criteria by id and the use case is
  // frozen at pair_start.
  const context = taskDesignContext(credentialBoard(), credentialBoard().tasks[0]);
  check(context.length === 1 && context[0].useCase === 'UC-1' && context[0].criteria.length === 1
    && context[0].criteria[0].id === 'UC-1.AC-1' && !JSON.stringify(context).includes('UC-1.AC-2'),
  'the design context carries this task\'s owned criteria, not the sibling\'s allocation of the same use case');

  // Byte-compat, captured at commit 4f35c9d (the last commit before this
  // matrix). A live board's credential is a stored digest; if the upgrade
  // re-digests a board that carries only pre-rule records, every task in every
  // running session wakes up stale — the very failure this matrix fixes.
  check(gateStateFingerprint(credentialBoard(), 't-1') === 'd62628b00ed017e562d0f073e08a53a0ee09c00ac597d81094ca747d9b6b84dd',
    'a board carrying only pre-rule records digests exactly as it did before the matrix (no live credential is invalidated by the upgrade)');

  /* ---------------------------------------------------------------------- */
  /* #16: the two exports a refusal is built from.                           */
  /* ---------------------------------------------------------------------- */
  const graded = credentialBoard();
  const breakdown = gateStateBreakdown(graded, 't-1');
  check(Object.keys(breakdown).sort().join() === 'cycles,decisions,design,risks,task'
    && Object.values(breakdown).every(value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)),
  'gateStateBreakdown names every judged input and digests each one');
  const bindingOf = board => ({ breakdown, breakdownIndex: gateStateIndex(graded, 't-1') });
  check(gateBindingDiff(graded, 't-1', bindingOf(graded)).length === 0
    && gateBindingDiff(graded, 't-1', {}).length === 0 && gateBindingDiff(graded, 't-1', undefined).length === 0,
  'a credential that recorded nothing, or whose board did not move, yields no invented diff line');
  const drifted = credentialBoard();
  drifted.protocol.decisions = [{ id: 'd-1b044190', taskId: 't-1', conflictRef: 'plan t-1', decision: 'x', rationale: 'r', at: 7 }];
  check(JSON.stringify(gateBindingDiff(drifted, 't-1', bindingOf(graded))) === '["decisions: added d-1b044190"]',
    'only one ruling was added, and the diff names that ruling id');
  // A caller that stored the digests without the id index must get what the
  // digest can prove and nothing more: claiming every ruling was "added"
  // because none could be compared is a diff that sends the captain to the
  // wrong input.
  const indexless = gateBindingDiff(drifted, 't-1', { breakdown });
  check(indexless.every(line => !line.includes('added')) && indexless.some(line => line.startsWith('decisions: input changed')),
    'without an id-level index the diff names the input that moved and claims no item was added');
  const recarded = credentialBoard();
  recarded.tasks[0].story.intent = 'change the plugin differently';
  recarded.protocol.cycles.push({ id: 'c-t-1-2-2', taskId: 't-1', step: 'PROPOSED', openedAt: 9 });
  recarded.protocol.risks = [{ id: 'r-leak', severity: 'P1', status: 'OPEN', scenario: 's', openedAt: 9 }];
  const lines = gateBindingDiff(recarded, 't-1', bindingOf(graded));
  check(lines.includes('task: field "story.intent" changed') && lines.includes('cycles: added c-t-1-2-2@PROPOSED')
    && lines.includes('risks: added r-leak(P1)'),
  'a contract change, a new cycle and a new blocker are each named with their id');

  /* ---------------------------------------------------------------------- */
  /* The measured loop, end to end: a board-mandated ruling must not negate  */
  /* the credential it was recorded to serve.                                */
  /* ---------------------------------------------------------------------- */
  const root = await mkdtemp(join(tmpdir(), 'pair-binding-'));
  const attempt = async fn => { try { return { value: await fn(), error: '' }; } catch (error) { return { value: undefined, error: String(error?.message ?? error) }; } };
  // A real frozen oracle on disk: the gate replays it, digests it and checks it
  // predates the work, so the fixture has to be a candidate that could exist.
  await writeFile(join(root, 'oracle.mjs'), 'process.exit(0);\n', 'utf8');
  const arm = async (board, agent) => {
    board.tasks[0].oracle = { sha: await digestOracleFiles(root, ['oracle.mjs']), files: ['oracle.mjs'], cmd: 'node oracle.mjs',
      redExit: 1, frozenAt: 4, divergences: [], caseRefs: ['UC-1.AC-1'] };
    board.protocol.cycles[0].oracleSha = board.tasks[0].oracle.sha;
    board.protocol.cycles[0].verify.binding.worktreeSha = await workspaceFingerprint(root, { stateDir: 'state' });
    board.protocol.cycles[0].verify.binding.gateStateSha = reviewStateFingerprint(board, 't-1');
    await createTeamDir(join(root, 'state'), board);
    return agent;
  };
  try {
    const h = harness(root);
    await arm(credentialBoard(), h.captain);
    const pass = await attempt(() => h.tool('pair_gate_check')({ task_id: 't-1' }, { agent: h.captain }));
    check(pass.error === '' && pass.value?.pass === true && typeof pass.value.gate_pass_id === 'string',
      'the gate issues a credential for the reviewed candidate');
    const beforeRuling = gateStateFingerprint(await readTeam(h.stateRoot, 'fresh'), 't-1');
    // Exactly what the captain did in the measured session: name the subject
    // task, close the cycle's own declared disclosure, and record why.
    const ruled = await h.tool('pair_arbitrate')({
      conflict_ref: 'cycle:c-t-1-1-1:deviation', decision: 'the deviation is the accepted tradeoff',
      evidence: ['git diff --stat: 12 lines'], rationale: 'the requested contract is met; the shim was out of scope',
      task_id: 't-1', closes_disclosure: 'cycle:c-t-1-1-1:deviation',
      disposition: 'accepted', sink: 'board', sink_ref: 't-1',
    }, { agent: h.captain });
    check(typeof ruled.decision_id === 'string', 'the board-mandated ruling is recorded');
    check(gateStateFingerprint(await readTeam(h.stateRoot, 'fresh'), 't-1') === beforeRuling,
      'the ruling that closes this cycle\'s own disclosure does not move this task\'s credential inputs');
    const again = await attempt(() => h.tool('pair_gate_check')({ task_id: 't-1' }, { agent: h.captain }));
    check(again.error === '' && again.value?.credential_reused === true,
      'the gate re-issues the SAME credential after the mandated ruling (no reopened cycle, no empty ACCEPT)');

    /* -------------------------------------------------------------------- */
    /* #16: a refusal must name the input that moved, with its id.           */
    /* -------------------------------------------------------------------- */
    const second = { id: 'cap2', session: { header: { cwd: root }, append() {} } };
    await arm(credentialBoard({ id: 'stale', name: 'Stale', captainSessionId: 'cap2' }), second);
    check((await attempt(() => h.tool('pair_gate_check')({ task_id: 't-1' }, { agent: second }))).error === '',
      'the second board gates cleanly before the drift');
    const dispute = await h.tool('pair_arbitrate')({
      conflict_ref: 'plan t-1', decision: 'split the card', evidence: ['board: 1 card'], rationale: 'two concerns cannot be verified independently',
      task_id: 't-1',
    }, { agent: second });
    const refusal = (await attempt(() => h.tool('pair_gate_check')({ task_id: 't-1' }, { agent: second }))).error;
    check(refusal.includes('GATE_STALE') && refusal.includes('final review'),
      'a genuine board change after the review still refuses the gate');
    check(refusal.includes('decisions:') && refusal.includes(dispute.decision_id),
      'the refusal names the changed input AND the ruling id that moved it');

    /* -------------------------------------------------------------------- */
    /* #131: the measured deadlock — final ACCEPT, then the captain closes    */
    /* the blocker the gate itself waits for, and the gate answers GATE_STALE. */
    /* -------------------------------------------------------------------- */
    const third = { id: 'cap3', session: { header: { cwd: root }, append() {} } };
    const blocked = credentialBoard({ id: 'blocked', name: 'Blocked', captainSessionId: 'cap3' });
    blocked.protocol.risks = [{ id: 'r-leak', severity: 'P0', status: 'OPEN', scenario: 'the emitted name will not match the acceptance test', trigger: 'any run of the emitter', suggestion: 'fix the emitter', raisedBy: 'challenger', scope: 'product', openedAt: 6 }];
    await arm(blocked, third);
    const refusedByRisk = await attempt(() => h.tool('pair_gate_check')({ task_id: 't-1' }, { agent: third }));
    check(refusedByRisk.error.includes('open P0') && refusedByRisk.error.includes('r-leak') && !refusedByRisk.error.includes('GATE_STALE'),
      `an open P0 refuses the gate on its own rule, before any credential is judged (got: ${refusedByRisk.error})`);
    const stored = await readTeam(h.stateRoot, 'blocked');
    mitigateRisk(stored.protocol, 'r-leak', 'the emitter now fails loudly on an unmatched name');
    closeRisk(stored.protocol, 'r-leak', 'verified by the frozen acceptance test', { closingCmd: 'node oracle.mjs', closingExit: 0, closingPaths: ['oracle.mjs'] });
    await writeTeam(h.stateRoot, stored);
    const afterClose = await attempt(() => h.tool('pair_gate_check')({ task_id: 't-1' }, { agent: third }));
    check(afterClose.error === '' && afterClose.value?.pass === true && typeof afterClose.value.gate_pass_id === 'string',
      '#131 closing the blocker after the final ACCEPT lets the gate issue the credential instead of answering GATE_STALE');
    const raisedLater = await readTeam(h.stateRoot, 'blocked');
    raisedLater.protocol.risks.push({ id: 'r-late', severity: 'P1', status: 'OPEN', scenario: 'raised after the review', trigger: 't', suggestion: 'x', raisedBy: 'challenger', scope: 'product', openedAt: 12 });
    await writeTeam(h.stateRoot, raisedLater);
    const lateRefusal = await attempt(() => h.tool('pair_gate_check')({ task_id: 't-1' }, { agent: third }));
    check(lateRefusal.error.includes('GATE_STALE'),
      '#131 while a blocker raised AFTER the review still refuses the gate (the arm is not weakened)');

    /* -------------------------------------------------------------------- */
    /* #126: a blocker on ANOTHER card is that card's business.               */
    /* -------------------------------------------------------------------- */
    const fourth = { id: 'cap4', session: { header: { cwd: root }, append() {} } };
    const elsewhere = credentialBoard({ id: 'elsewhere', name: 'Elsewhere', captainSessionId: 'cap4' });
    elsewhere.protocol.risks = [{ id: 'r-elsewhere', severity: 'P0', status: 'OPEN', scenario: 'the other card emits a wrong name', trigger: 't', suggestion: 'x', raisedBy: 'challenger', scope: 'product', taskId: 't-2', openedAt: 6 }];
    await arm(elsewhere, fourth);
    const crossCard = await attempt(() => h.tool('pair_gate_check')({ task_id: 't-1' }, { agent: fourth }));
    check(crossCard.error === '' && crossCard.value?.pass === true,
      `#126 a P0 attributed to another card does not block this one (got: ${crossCard.error || JSON.stringify(crossCard.value?.failures)})`);
    const fifth = { id: 'cap5', session: { header: { cwd: root }, append() {} } };
    const ownCard = credentialBoard({ id: 'own', name: 'Own', captainSessionId: 'cap5' });
    ownCard.protocol.risks = [{ ...elsewhere.protocol.risks[0], taskId: 't-1' }];
    await arm(ownCard, fifth);
    const blockedOwn = await attempt(() => h.tool('pair_gate_check')({ task_id: 't-1' }, { agent: fifth }));
    check(blockedOwn.error.includes('open P0') && blockedOwn.error.includes('r-elsewhere'),
      `#126 while the same P0 attributed to THIS card still refuses it (got: ${blockedOwn.error})`);

    /* -------------------------------------------------------------------- */
    /* D3: the digest's own definition is off-board, so the refusal must      */
    /* name it rather than sending the reader after a phantom board write.    */
    /* -------------------------------------------------------------------- */
    const sixth = { id: 'cap6', session: { header: { cwd: root }, append() {} } };
    const upgraded = credentialBoard({ id: 'upgraded', name: 'Upgraded', captainSessionId: 'cap6' });
    upgraded.protocol.risks = [{ id: 'r-old', severity: 'P1', status: 'WONTFIX', scenario: 'the retry is not idempotent', trigger: 't', suggestion: 'x', raisedBy: 'navigator', scope: 'product', openedAt: 6, closedAt: 7, wontfixRationale: 'the mitigation in hand is the whole remedy' }];
    await arm(upgraded, sixth);
    const armed = await attempt(() => h.tool('pair_gate_check')({ task_id: 't-1' }, { agent: sixth }));
    // What a digest-definition change looks like from the credential's side: the SAME
    // ticket ids, carrying the per-id digests the PREVIOUS definition produced. No
    // board write happened, and the credential cannot tell the two apart.
    const held = await readTeam(h.stateRoot, 'upgraded');
    const heldPass = held.protocol.gatePasses.filter(item => item.taskId === 't-1').at(-1);
    heldPass.binding.breakdownIndex.risks = Object.fromEntries(Object.keys(heldPass.binding.breakdownIndex.risks).map(key => [key, 'e'.repeat(64)]));
    heldPass.binding.breakdown.risks = 'f'.repeat(64);
    held.protocol.cycles[0].verify.binding.gateStateSha = 'minted-before-the-definition-changed';
    await writeTeam(h.stateRoot, held);
    const upgradedRefusal = (await attempt(() => h.tool('pair_gate_check')({ task_id: 't-1' }, { agent: sixth }))).error;
    check(armed.error === '' && upgradedRefusal.includes('GATE_STALE')
      && upgradedRefusal.includes('risks: changed r-old(P1)')
      && upgradedRefusal.includes("digest's own definition") && upgradedRefusal.includes('re-running the gate is the recovery'),
      `D3 the refusal for a moved risk register with no ticket added or removed names the digest-definition change as the alternative cause instead of a phantom board write (got: ${upgradedRefusal})`);
  } finally { await rm(root, { recursive: true, force: true }); }
}
