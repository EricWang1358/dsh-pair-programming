/**
 * v4 solo mode: independence from TIME, not from IDENTITY.
 *
 * The measured case against seats: across eight SWE-bench rounds and three live
 * sessions the review seats produced zero NO_GO and zero REJECT, one session ran
 * 28 proposals against 0 verifies, and on pylint-8898 the paired arm returned a
 * wrong answer for 1.375x the tokens of a lone agent — the shape of one Driver
 * plus overhead, not of three agents working.
 *
 * What did produce information the implementer could not have is the frozen
 * oracle. Its independence never depended on a different NAME holding the pen;
 * it depended on the pen moving before the implementation existed. Solo keeps
 * exactly that and drops the rest.
 */
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolDenyListFor } from '../lib/runtime/members.js';
import { specPersona, captainProtocol, navigatorPersona } from '../lib/protocol/personas.js';
import { usageSectionText } from '../lib/prompt.js';
import { TEAM_MODES, DEFAULTS } from '../lib/defaults.js';
import { registerFlowTools } from '../lib/tools/flow.js';
import { registerOracleTools } from '../lib/tools/oracle.js';
import { createTeamDir, readTeam } from '../lib/state/store.js';
import { initialProtocolState } from '../lib/protocol/machine.js';

const HOST_TOOLS = ['read', 'write', 'edit', 'pwsh', 'bash', 'Bash', 'glob', 'grep', 'apply_patch',
  'pair_oracle', 'pair_oracle_write', 'pair_status', 'pair_propose', 'pair_green', 'pair_verify', 'pair_start'];

const member = (id, role) => ({ id, name: role, role, status: 'idle', joinedAt: 1 });

function soloTeam(over = {}) {
  return {
    id: 'sv1', name: 'SV', goal: 'fix the comma splitter', mode: 'solo', tddMode: 'enforce', pairStyle: 'traditional',
    captainSessionId: 'cap1', createdAt: 1, updatedAt: 1,
    members: [member('child-spec', 'spec')],
    tasks: [{ id: 't-1', subject: 's', status: 'in_progress', assignee: 'captain', attemptId: 'a-1', dependencies: [], createdAt: 1, updatedAt: 1 }],
    taskSeq: 1, protocol: { ...initialProtocolState(), phase: 'PLANNING' }, evidenceStats: { cacheHits: 0, cacheMiss: 0 }, ...over,
  };
}

function harness(root, stateDir) {
  const defs = [];
  const ctx = {
    logger: { warn: () => {}, debug: () => {}, error: () => {} },
    tools: { register: (d) => { defs.push(d); } },
    agents: { get: (id) => (id === 'cap1' ? { id: 'cap1', session: { append: () => {} } } : undefined) },
    subagents: { sendMessage: async () => 'm-1' },
  };
  const config = { stateDir, tddMode: 'enforce', maxCyclesPerTask: 12, oracleFirst: true, evidenceCache: false };
  registerFlowTools(ctx, config, { scheduler: {} });
  registerOracleTools(ctx, config);
  const sess = (id) => ({ id, session: { header: { cwd: root }, append: () => {} } });
  return { tool: (n) => defs.find(d => d.name === n).execute, captain: sess('cap1'), spec: sess('child-spec'), stateRoot: join(root, stateDir) };
}

const fails = (fn) => fn().then(() => 'no throw', (e) => String(e?.message ?? e));

export async function run(check) {
  const root = await mkdtemp(join(tmpdir(), 'pair-solo-'));
  try {
    /* ---- A: the isolation is a sandbox property, not a request -------- */
    const denied = new Set(toolDenyListFor('spec', HOST_TOOLS));
    for (const blind of ['read', 'glob', 'grep', 'pwsh', 'bash', 'Bash', 'write', 'edit', 'apply_patch']) {
      check(denied.has(blind), `A the SPEC seat cannot ${blind} — it must not be able to consult an implementation`);
    }
    check(!denied.has('pair_oracle') && !denied.has('pair_oracle_write'), 'A it keeps exactly the two tools that author and seal the standard');
    check(!denied.has('pair_status'), 'A and can read the board it is writing against');
    check(denied.has('pair_propose'), 'A it cannot open a cycle: authoring the standard and meeting it are different jobs');
    let unreadable = 'no throw';
    try { toolDenyListFor('spec', []); } catch (e) { unreadable = String(e.message); }
    check(unreadable.includes('cannot be isolated'), 'A an unreadable tool registry refuses the team rather than shipping an oracle that may have peeked');

    /* ---- B: the prompt shrinks because the rules moved into the tools -- */
    const specTok = Math.round(specPersona({ name: 'n', goal: 'g' }, { name: 'spec' }, '.p').length / 4);
    const navTok = Math.round(navigatorPersona({ name: 'n', goal: 'g', tddMode: 'enforce' }, { name: 'x' }, '.p').length / 4);
    check(specTok < navTok / 2, `B the SPEC prompt is under half the Navigator it replaces (${specTok} vs ${navTok} tok)`);
    const solo = captainProtocol({ tddMode: 'enforce' });
    const legacy = captainProtocol({ tddMode: 'enforce', defaultMode: 'light' });
    check(solo.length < legacy.length / 2, 'B the solo protocol is under half the multi-seat one');
    for (const enforced of ['planningMaxArbitrations', 'red build', 'as a user', '70%', 'beyond_request', 'deliverables']) {
      check(solo.includes(enforced), `B solo still names "${enforced}" — it is enforced, so it is stated`);
    }
    for (const gone of ['Challenger', 'single writer', 'busy-poll']) {
      check(!solo.includes(gone), `B solo drops "${gone}" — no such party exists to coordinate`);
    }
    check(solo.includes('completion_receipt'), 'B solo binds host-goal completion to the board receipt');
    check(!solo.includes('max_goal_rounds') && !solo.includes('create_goal'), 'B solo no longer turns goal rounds into a polling clock');
    check(usageSectionText({ tddMode: 'enforce' }).includes('1.375x'), 'B the usage text says what the legacy modes measured, so choosing one is informed');

    /* ---- C: solo relaxes WHO, never WHAT makes a verdict valid -------- */
    const h = harness(root, 'solo-state');
    await createTeamDir(h.stateRoot, soloTeam());
    await mkdir(join(root, '.pair-oracles', 't-1'), { recursive: true });

    const captainWrites = await fails(() => h.tool('pair_oracle_write')({ task_id: 't-1', path: '.pair-oracles/t-1/o.mjs', content: 'x' }, { agent: h.captain }));
    check(captainWrites.includes('SPEC seat'), 'C the builder cannot author its own acceptance standard');
    await h.tool('pair_oracle_write')({ task_id: 't-1', path: '.pair-oracles/t-1/o.mjs', content: 'process.exit(process.env.FIXED === "1" ? 0 : 1);\n' }, { agent: h.spec });
    const frozen = await h.tool('pair_oracle')({
      task_id: 't-1',
      readings: ['commas inside a brace quantifier must not split', 'a backslash escapes a comma'],
      chosen_reading: 'commas inside a brace quantifier must not split',
      divergence_candidates: ['a hidden test may assert the unescaped form round-trips'],
      oracle_files: ['.pair-oracles/t-1/o.mjs'], oracle_cmd: 'node .pair-oracles/t-1/o.mjs',
    }, { agent: h.spec });
    check(frozen.oracle_sha.length === 64 && frozen.red_exit !== 0, 'C the SPEC seat freezes a standard that fails today');

    const specBuilds = await fails(() => h.tool('pair_propose')({ task_id: 't-1', intent: 'i', files: ['a.js'], net_lines: 3, verify_plan: 'v' }, { agent: h.spec }));
    check(specBuilds.includes('never sees the implementation'), 'C the SPEC seat cannot then implement against its own standard');

    const proposed = await h.tool('pair_propose')({ task_id: 't-1', intent: 'brace-aware split', files: ['a.js'], net_lines: 4, verify_plan: 'run the oracle' }, { agent: h.captain });
    check(proposed.cycle_id !== undefined, 'C the builder proposes without needing a Driver seat to exist');
    await h.tool('pair_green')({ cycle_id: proposed.cycle_id, green_evidence: ['ok'], diff_summary: 'a.js +4/-1', test_results: 'suite ok', tuned_for_oracle: 'none' }, { agent: h.captain });

    const stillRed = await h.tool('pair_verify')({ cycle_id: proposed.cycle_id, beyond_request: 'nothing', preexisting_at_risk: 'none; ran the suite' }, { agent: h.captain });
    check(stillRed.verdict === 'reject' && stillRed.computed === true, 'C THE point: the builder cannot pass its own work — the sealed command still fails, so the verdict is REJECT');

    process.env.FIXED = '1';
    await h.tool('pair_green')({ cycle_id: proposed.cycle_id, green_evidence: ['green'], diff_summary: 'a.js +4/-1', test_results: 'suite ok', tuned_for_oracle: 'the shell inflation stayed at 1.02 because the request asked for a visible rim; nothing was sized to the oracle' }, { agent: h.captain });
    const passed = await h.tool('pair_verify')({ cycle_id: proposed.cycle_id, beyond_request: 'nothing beyond brace handling', preexisting_at_risk: 'the list/tuple passthrough; re-ran the config suite' }, { agent: h.captain });
    check(passed.verdict === 'accept' && passed.computed === true, 'C and it passes only when the independently-authored command actually passes');
    const board = await readTeam(h.stateRoot, 'sv1');
    check(board.protocol.cycles[0].verify.beyondRequest.includes('brace'), 'C the scope reading is recorded — a computed verdict is blind to behaviour nobody requested');
    delete process.env.FIXED;

    /* ---- I2 above the auto-GO threshold is no longer prose ------------ */
    // Measured: three files, ~300 net lines, two plainly separate concerns
    // (weather and life) proposed as one cycle — and GO'd, in a session whose
    // review seat issued zero NO_GO all run. net_lines only ever decided
    // whether the GO round was skipped; an oversized proposal was simply one
    // that waited. The tool still cannot judge "one concern" and does not
    // pretend to; it makes the claim explicit so a reviewer has something to
    // refuse.
    const oversized = await fails(() => h.tool('pair_propose')({ task_id: 't-1', intent: 'weather and life', files: ['weather.js', 'life.js', 'buildScene.js'], net_lines: 300, verify_plan: 'run the oracle' }, { agent: h.captain }));
    check(oversized.includes('why_not_split') && oversized.includes('verified independently'), 'a multi-file, 300-line cycle must state why it is still ONE concern');
    check(oversized.includes('split it'), 'and the refusal says what to do when that sentence cannot be written');
    const justified = await h.tool('pair_propose')({ task_id: 't-1', intent: 'weather and life', files: ['weather.js', 'life.js'], net_lines: 300, verify_plan: 'run the oracle', why_not_split: 'both halves register against the same animator array; split, neither half has a runnable frame loop to assert on' }, { agent: h.captain });
    check(justified.cycle_id !== undefined, 'a stated rationale lets the oversized step through — this is friction, not a wall');
    const boardSplit = await readTeam(h.stateRoot, 'sv1');
    check(boardSplit.protocol.cycles.at(-1).proposal.whyNotSplit.includes('animator array'), 'and the claim is recorded on the cycle, where a reviewer and the retro can weigh it');

    /* ---- D: no oracle, no self-acceptance ----------------------------- */
    const h2 = harness(root, 'solo-state-2');
    const t2 = soloTeam({ id: 'sv2', members: [member('spec-2', 'spec')] });
    t2.tasks[0].trivial = true;
    await createTeamDir(h2.stateRoot, t2);
    const bare = await h2.tool('pair_propose')({ task_id: 't-1', intent: 'i', files: ['a.js'], net_lines: 2, verify_plan: 'v' }, { agent: h2.captain });
    await h2.tool('pair_report')({ cycle_id: bare.cycle_id, diff_summary: 'd', test_results: 't' }, { agent: h2.captain });
    const selfAccept = await fails(() => h2.tool('pair_verify')({ cycle_id: bare.cycle_id, verdict: 'accept', evidence: ['looks right'] }, { agent: h2.captain }));
    check(selfAccept.includes('computed verdict') && selfAccept.includes('correlated judgement'), 'D THE guard that makes solo honest: with no frozen oracle there is no second seat to catch you, so an asserted self-ACCEPT is refused outright');

    /* ---- F: the solo builder can hold an attempt token ---------------- */
    const h3 = harness(root, 'solo-state-3');
    const t3 = soloTeam({ id: 'sv3', members: [member('spec-3', 'spec')] });
    t3.tasks[0].status = 'pending';
    delete t3.tasks[0].assignee;
    delete t3.tasks[0].attemptId;
    await createTeamDir(h3.stateRoot, t3);
    const claimed = await h3.tool('pair_task_claim')({ task_id: 't-1' }, { agent: h3.captain });
    check(typeof claimed.attempt_id === 'string' && claimed.attempt_id.length > 0, 'F the solo builder claims its own task and gets a real attempt token');
    const stale = await fails(() => h3.tool('pair_task_update')({ task_id: 't-1', status: 'in_progress', attempt_id: 'not-the-one' }, { agent: h3.captain }));
    check(stale.includes('stale attempt_id'), 'F and a stale token still fails loudly — solo drops the seat, never the capability check');

    /* ---- G: scope is measured from a baseline, not from HEAD ---------- */
    const { checkScope } = await import('../lib/tools/gate-exec.js');
    const dirty = { ref: 'HEAD', dirtyFiles: ['already/edited.js'] };
    const noGit = await checkScope(join(root, 'not-a-repo'), ['a.js'], dirty);
    check(noGit === undefined, 'G outside git the scope check stays silent rather than guessing');

    /* ---- E: the mode is the default and reachable everywhere ---------- */
    check(DEFAULTS.defaultMode === 'solo' && TEAM_MODES[0] === 'solo', 'E solo is the default and the cheapest option listed first');
    check(TEAM_MODES.includes('light') && TEAM_MODES.includes('full'), 'E the measured multi-seat modes remain available, not deleted');
  } finally {
    delete process.env.FIXED;
    await rm(root, { recursive: true, force: true });
  }
}
