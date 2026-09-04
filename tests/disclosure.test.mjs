/** Declared blind spots become owned board obligations instead of dead prose. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { declares, knownDisclosureRefs, openDisclosures } from '../lib/protocol/disclosure.js';
import { completionReadiness } from '../lib/protocol/completion.js';
import { boardDigest } from '../lib/protocol/digest.js';
import { nextObligation, obligationLine } from '../lib/protocol/obligation.js';
import { initialProtocolState } from '../lib/protocol/machine.js';
import { registerArbitrateTools } from '../lib/tools/arbitrate.js';
import { registerLifecycleTools } from '../lib/tools/lifecycle.js';
import { createTeamDir, readTeam } from '../lib/state/store.js';

const fails = fn => fn().then(() => '', error => String(error?.message ?? error));

function fixture() {
  const protocol = initialProtocolState();
  protocol.phase = 'RETRO';
  protocol.cycles.push({
    id: 'c-1', taskId: 't-1', step: 'VERIFIED', openedAt: 2,
    green: { tunedForOracle: 'none — values came from the request' },
    verify: { verdict: 'accept', computed: true, beyondRequest: 'added a visual fallback', evidence: ['green'], at: 3 },
  });
  protocol.gatePasses.push({ id: 'gp-1', taskId: 't-1', at: 4 });
  protocol.risks.push({ id: 'r-1', severity: 'P2', status: 'OPEN', scenario: 'visual polish', openedAt: 1 });
  return {
    id: 'disc', name: 'Disclosure', goal: 'ship honestly', mode: 'solo', captainSessionId: 'cap',
    createdAt: 1, updatedAt: 1, members: [], taskSeq: 1,
    useCases: [{ id: 'UC-1', actor: 'viewer', intent: 'inspect', outcome: 'see result', acceptanceCriteria: [{ id: 'UC-1.AC-1', text: 'visible' }] }],
    tasks: [{
      id: 't-1', subject: 'scene', status: 'completed', gatePassId: 'gp-1', dependencies: [], acceptanceRefs: ['UC-1.AC-1'],
      oracle: { sha: 'abcdef0123456789', files: ['o.mjs'], cmd: 'node o.mjs', redExit: 1, divergences: [], caseRefs: ['UC-1.AC-1'], nonGating: ['visual-quality'], nonGatingReason: 'human judgement deferred' },
      createdAt: 1, updatedAt: 1,
    }],
    protocol, processLessons: { at: 5, keep: [], try: [] }, evidenceStats: { cacheHits: 0, cacheMiss: 0 },
  };
}

function harness(root) {
  const defs = [];
  const ctx = {
    logger: { warn() {}, debug() {}, error() {} }, tools: { register: def => defs.push(def) },
    agents: { get: () => undefined }, subagents: { followup: async () => true, interrupt() {} },
  };
  const config = { stateDir: 'state', planningMaxArbitrations: 2, greenBuildOnStop: false };
  registerArbitrateTools(ctx, config, { scheduler: {} });
  registerLifecycleTools(ctx, config, { selections: {}, scheduler: {} });
  return { tool: name => defs.find(def => def.name === name).execute, captain: { id: 'cap', session: { header: { cwd: root }, append() {} } }, stateRoot: join(root, 'state') };
}

export async function run(check) {
  check(!declares('nothing — the hunk is minimal') && !declares('none: request value used') && !declares('no deviations from the approved proposal') && declares('added a visual fallback'), 'disclosure parser distinguishes explicit none-style answers from an actual gap');
  const initial = fixture();
  const refs = knownDisclosureRefs(initial);
  check(refs.some(ref => ref === 'oracle:t-1:abcdef012345:non-gating') && refs.some(ref => ref === 'cycle:c-1:beyond'), 'disclosure refs bind non-gating arms to the oracle seal and cycle fields to the cycle');
  check(openDisclosures(initial).length === 2, 'every real declaration is open while none-style fields stay closed');
  check(completionReadiness(initial, { greenEvidence: 'green' }).failures.some(failure => failure.includes('nobody has ruled')), 'successful stop is blocked by an unowned disclosure');
  const owed = nextObligation(initial);
  check(owed.who === 'captain' && owed.tool === 'pair_arbitrate' && obligationLine(owed, 'captain').includes('YOU owe'), 'a settled board assigns the next disclosure ruling to the captain');
  check(boardDigest(initial).includes('Open disclosures') && boardDigest(initial).includes('cycle:c-1:beyond'), 'recycled seats receive open disclosures in the board digest');

  const root = await mkdtemp(join(tmpdir(), 'pair-disc-'));
  try {
    const h = harness(root);
    await createTeamDir(h.stateRoot, initial);
    const typo = await fails(() => h.tool('pair_arbitrate')({ conflict_ref: 'visual ruling', decision: 'accept gap', evidence: ['review.png'], rationale: 'bounded tradeoff', closes_disclosure: 'oracle:t-1:wrong:non-gating' }, { agent: h.captain }));
    check(typo.includes('no declared disclosure') && typo.includes('pair_status'), 'a ruling cannot close a mistyped disclosure ref');
    const ruled = await h.tool('pair_arbitrate')({ conflict_ref: 'visual ruling', decision: 'accept visual arm as backlog', evidence: ['review.png'], rationale: 'the requested structural contract is met; visual polish is tracked separately', closes_disclosure: refs[0] }, { agent: h.captain });
    check(ruled.closes_disclosure === refs[0], 'pair_arbitrate returns the exact disclosure it closed');
    const after = await readTeam(h.stateRoot, 'disc');
    check(openDisclosures(after).length === 1 && after.protocol.decisions[0].closesDisclosure === refs[0], 'the ruling closes exactly one blind spot and leaves the other visible');
    const status = await h.tool('pair_status')({}, { agent: h.captain });
    check(status.risks.length === 1 && status.open_risks.length === 1, 'pair_status exposes both the stable risks field and the filtered open_risks view');
    check(status.status_schema_version === 1 && status.cycles.length === 1 && status.coverage === status.goal_coverage, 'pair_status keeps cycles and both coverage names on one versioned structured surface');
    check(status.open_disclosures.length === 1 && status.summary.includes('Open disclosures'), 'pair_status exposes open disclosures in structured and rendered output');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
