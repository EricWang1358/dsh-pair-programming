/**
 * A verdict may never be manufactured from a malformed declaration.
 *
 * The measured failure, from the oj-forge-s2 board. `pair_propose.verify_plan`
 * was documented as "How the change will be verified (test/build/lint
 * command)" — a leading clause that invites prose, a parenthetical that asks
 * for a command, and nothing checking which one arrived. A Driver declared
 *
 *   1) npm test must stay fully green  2) Live adapter smoke: node --input …
 *
 * and two steps later `pair_verify(stage="checkpoint")` handed that string to
 * the shell. Non-zero exit became `verdict: 'reject', category:
 * 'checkpoint_red'` — "the cycle's predeclared verify_plan still fails". The
 * code was fine.
 *
 * Why that is a protocol bug and not a papercut: this protocol's whole claim
 * is that a verdict is a re-run rather than an assertion. A false REJECT
 * breaks the claim from the other side — it charges `stats.reject` and the
 * cycle's rejection budget for a failure that never happened, rewinds the
 * cycle out of its GO, and delivers structured feedback about code that was
 * never the problem. Evidence that can be wrong for reasons unrelated to the
 * product is not evidence.
 */
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandShapeError, isRunnableCommand, notRunnableEvidence, exitSemantics, classifyRun, instrumentFailure, normalizeInstrumentExitCodes, instrumentExitCodeProblem } from '../lib/protocol/command-shape.js';
import { runOracleCommand } from '../lib/tools/oracle-exec.js';
import { runDodCommand } from '../lib/tools/gate-exec.js';
import { registerFlowTools } from '../lib/tools/flow.js';
import { registerOracleTools } from '../lib/tools/oracle.js';
import { createTeamDir, readTeam, writeTeam } from '../lib/state/store.js';
import { initialProtocolState, openCycle } from '../lib/protocol/machine.js';
import { digestOracleFiles } from '../lib/tools/oracle-exec.js';
import { redProblem } from '../lib/protocol/oracle.js';
import { settingsValueError } from '../lib/settings.js';

export async function run(check) {
  /* ---- commands pass, including awkward ones --------------------------- */
  const runnable = [
    'npm test',
    'node tests/run.mjs',
    'npm run verify && node scripts/verify-package.mjs',
    'pytest -q tests/',
    './gradlew :app:testDebugUnitTest',
    'cargo test --all-features',
    'C:\\tools\\run.bat --fast',
    'node --input-type=module -e "import(\'./x.js\')"',
  ];
  for (const command of runnable) {
    check(isRunnableCommand(command), `a real command line is accepted: ${command.slice(0, 40)}`);
  }

  /* ---- the exact shape that produced the false REJECT ------------------- */
  const measured = '1) npm test must stay fully green  2) Live adapter smoke: node --input';
  const measuredError = commandShapeError(measured);
  check(measuredError !== undefined, 'the plan that caused the measured false REJECT is refused');
  check(measuredError.includes('list marker') || measuredError.includes('requirement'), 'and the refusal names what makes it a plan rather than a command');
  check(measuredError.includes('EXECUTED verbatim'), 'and states the consequence that makes this matter');
  check(measuredError.includes('intent'), 'and points at where the reasoning belongs instead');

  /* ---- each prose shape, named separately ------------------------------ */
  check(commandShapeError('npm test\nnode extra.mjs').includes('2 lines'), 'a multi-line plan is refused with its line count');
  check(commandShapeError('npm test\nnode extra.mjs').includes('&&'), 'and is told how to make it one command');
  check(commandShapeError('- npm test').includes('list marker'), 'a bulleted line is refused');
  check(commandShapeError('2. npm test').includes('list marker'), 'a numbered line is refused');
  check(commandShapeError('npm test must stay green').includes('requirement'), 'a requirement sentence is refused');
  check(commandShapeError('the suite should pass').includes('requirement'), 'so is a "should" clause');
  check(commandShapeError('Run the suite, then check the adapter. ').includes('prose'), 'sentence punctuation is refused');
  check(commandShapeError('运行测试，然后检查适配器').includes('prose'), 'including full-width punctuation, since the plan may be written in any language');
  check(commandShapeError('').includes('empty'), 'an empty plan is refused before anything else');
  check(commandShapeError(undefined).includes('empty'), 'and so is a missing one');

  /* ---- the refusal is usable ------------------------------------------- */
  const named = commandShapeError('a plan, not a command. ', { field: 'this cycle\'s proposal.verify_plan' });
  check(named.startsWith('this cycle\'s proposal.verify_plan'), 'the caller names the field, so the same check reads correctly at declaration and at execution');

  /* ---- permissive by design -------------------------------------------- */
  // Refusing a valid command would block real work; accepting prose only
  // defers the error to the shell, which is the bug. When in doubt, accept.
  check(isRunnableCommand('make check'), 'a two-word command with no punctuation is accepted');
  check(isRunnableCommand('sh -c "npm test && npm run lint"'), 'a quoted compound command is accepted');
  check(isRunnableCommand('npx vitest run --reporter=dot'), 'flags and equals signs do not read as prose');

  /* ---- "it failed" vs "it never ran" ----------------------------------- */
  // A shape check cannot catch `npn test`: it is a perfectly well-formed
  // command line naming a program that does not exist. Only the run can tell,
  // and only by looking at HOW it failed.
  check(notRunnableEvidence({ exit: 1, command: 'npm test', outputTail: '3 failing' }) === undefined, 'an ordinary non-zero exit is a real result about the code');
  check(notRunnableEvidence({ exit: 0, command: 'npm test' }) === undefined, 'so is a pass');
  check(notRunnableEvidence({ exit: 127, command: 'npn test' }).includes('could not find'), 'a POSIX not-found exit is recognised');
  check(notRunnableEvidence({ exit: 9009, command: 'npn test' }).includes('could not find'), 'and the Windows one');
  check(notRunnableEvidence({ exit: 'error', command: 'npn test' }).includes('spawn failure'), 'a spawn-level failure is recognised');
  check(notRunnableEvidence({ exit: 1, command: 'npn test', outputTail: "'npn' is not recognized as an internal or external command" }).includes('not a runnable program'), 'a shell that reports not-found through exit 1 is still caught');
  check(notRunnableEvidence({ exit: 127, command: 'npn test' }).includes('npn'), 'the refusal names the program it could not find');
  // A localized shell: the sentence is translated and arrives as mojibake on a
  // non-UTF-8 codepage, so only the quoted program name is still readable.
  check(notRunnableEvidence({ exit: 1, command: 'npn test', outputTail: "'npn' 不是内部或外部命令" }) !== undefined, 'a translated not-found message is caught by the name it quotes');
  check(notRunnableEvidence({ exit: 1, command: 'npm test', outputTail: "'foo' is undefined at line 3\n2 failing" }) === undefined, 'a suite that quotes something OTHER than the program it ran is a real result');
  check(notRunnableEvidence({ exit: 0, command: 'npn test', outputTail: "'npn' 不是内部或外部命令" }) === undefined, 'a command that exited 0 ran, whatever it printed');
  check(notRunnableEvidence(undefined) === undefined, 'no run, no claim');

  /* ---- the freeze gate no longer rewards an unrunnable command --------- */
  // redProblem demands a FAILING command — that is what makes it a RED. So it
  // used to accept a typo: the typo fails, seals into the task contract, and
  // then "fails" identically at every later verdict while the board reads
  // "acceptance still unmet".
  check(redProblem({ exit: 1, command: 'node tests/acceptance.mjs', outputTail: 'AssertionError' }) === undefined, 'a genuine red still freezes');
  check(redProblem({ exit: 0, command: 'npm test' }).includes('PASSES'), 'a green command is still refused');
  check(redProblem({ exit: 'timeout', command: 'npm test' }).includes('timed out'), 'a timeout is still refused');
  const typo = redProblem({ exit: 127, command: 'npn test', outputTail: '' });
  check(typo !== undefined, 'a command that never ran is no longer accepted as a red');
  check(typo.includes('behaviour is absent, not because the command is wrong'), 'and the refusal names the distinction that makes it wrong');

  /* ---- the same check guards the two other executed fields ------------- */
  const base = { tddMode: 'enforce', pairStyle: 'traditional', defaultMode: 'solo', memberLifetime: 'cycle', maxCyclesPerTask: 12, spikeMaxCycles: 2, maxOpenRisks: 15, planningMaxArbitrations: 2, dod: '' };
  check(settingsValueError({ ...base, dodCommand: 'node tests/run.mjs' }) === undefined, 'a runnable dodCommand is accepted');
  check(settingsValueError({ ...base, dodCommand: '' }) === undefined, 'an empty dodCommand stays optional');
  const badDod = settingsValueError({ ...base, dodCommand: 'the full suite must stay green' });
  /* ---- an ENOENT in the output is not "the program could not start" ----- */
  // Measured (B7). A legitimate in-script ENOENT was read as a program-start
  // failure and refused an oracle freeze with VERIFICATION_INFRASTRUCTURE. The
  // phrase "No such file or directory" comes from a script failing to read its
  // OWN input file at least as often as from a shell that could not find a
  // program, and it was matched against the output text with no idea who the
  // sentence was about.
  const inScript = { exit: 1, command: 'node tests/acceptance.mjs', outputTail: "node:fs:448\n  return binding.readFileUtf8(path, stringToFlags(options.flag));\n                 ^\n\nError: ENOENT: no such file or directory, open 'fixtures/pool.json'" };
  check(notRunnableEvidence(inScript) === undefined, 'THE measured regression: a script that cannot read its own input is a failure about the code, not a program that never started');
  check(notRunnableEvidence({ exit: 1, command: 'npm test', outputTail: "Error: ENOENT: no such file or directory, stat '/tmp/missing'" }) === undefined, 'and a runner whose own prefix names a file it could not read is still a real result');
  check(notRunnableEvidence({ exit: 1, command: 'npm test', outputTail: 'sh: 1: npm: not found' }) !== undefined, 'while a shell that really could not run the PROGRAM is still caught, by the name in the sentence');
  check(notRunnableEvidence({ exit: 126, command: './run.sh', outputTail: 'bash: ./run.sh: Permission denied' }) !== undefined, 'a program the shell refused to execute never ran either');
  check(notRunnableEvidence({ exit: 1, command: 'pytest -q tests/', outputTail: 'ERROR: file or directory not found: tests/' }) === undefined, 'a tool reporting a path it could not find is about its input, not about the program that started');

  /* ---- a declared exit code means "the measurement failed" -------------- */
  // B7(b): exit 2 is NOT globally an environment failure — on most tools it is
  // an ordinary one — so nothing here is redefined globally. The contract that
  // authored the command declares it, and every consumer reads that contract.
  check(instrumentExitCodeProblem([2]) === undefined, 'a contract may declare an instrument exit code');
  check(String(instrumentExitCodeProblem([0])).includes('not redefinable'), 'but success is not redefinable: declaring 0 would turn every green run into "no verdict"');
  check(String(instrumentExitCodeProblem(['two'])).includes('instrument_exit_codes'), 'and a non-integer is refused where it is declared, not at the gate');
  check(typeof instrumentExitCodeProblem(2) === 'string', 'a bare number is refused — the declaration is a list');
  check(normalizeInstrumentExitCodes(['2', 2, 7]).join(',') === '2,7', 'a declared list normalizes to distinct integers');
  const plain = exitSemantics({});
  check(plain['0'] === 'success' && plain.default === 'failure (product verdict)' && plain['2'] === undefined, 'with no declaration the classic semantics hold: 0 succeeds, anything else is a verdict about the code');
  const declared = exitSemantics({ instrumentExitCodes: [2] });
  check(String(declared['2']).startsWith('instrument') && declared['1'] === undefined, 'the mapping is printable per code, so pair_status can show the contract the team is judged by');
  check(classifyRun({ exit: 'error', command: 'npn test' }).kind === 'process-creation-failure', 'the categories stay distinct: a program that never started');
  check(classifyRun({ exit: 1, command: 'npm test', outputTail: '3 failing' }).kind === 'assertion-failure', 'an assertion that failed');
  check(classifyRun({ exit: 2, command: 'runner' }, declared).kind === 'test-infrastructure-failure', 'a declared instrument failure');
  check(classifyRun({ exit: 1, command: 'runner' }, declared).kind === 'assertion-failure', 'and an undeclared neighbouring code stays a product failure');
  check(classifyRun({ exit: 'timeout', command: 'runner' }, declared).kind === 'timeout', 'a timeout is not a result');
  check(classifyRun({ exit: 'cancelled', command: 'runner' }, declared).kind === 'cancellation', 'and neither is a cancellation');
  check(instrumentFailure({ exit: 1, command: 'npm test' }, declared) === undefined, 'an ordinary exit 1 is still a failure everywhere');
  const hint = instrumentFailure({ exit: 2, command: 'runner' }, declared);
  check(hint.includes('No product verdict') && hint.includes('re-run the same command'), 'a declared instrument failure records no verdict and carries the retry hint');

  /* ---- one place runs commands, so four call sites stop disagreeing ----- */
  // Measured: pair_integrate read any non-zero exit as INTEGRATION_ORACLE_FAILED
  // while pair_verify recorded the same exit as a REJECT and the gate counted it
  // as a failed gate. The judgement is made where the command is run, against
  // the declaration the contract carries.
  const fails = (fn) => fn().then(() => '', (error) => String(error && error.message ? error.message : error));
  const root = await mkdtemp(join(tmpdir(), 'pair-instrument-'));
  try {
    await writeFile(join(root, 'assert.cjs'), 'process.exit(1);');
    await writeFile(join(root, 'instrument.cjs'), "console.error('PREREQ: pool link unavailable');process.exit(2);");
    const failed = await runOracleCommand(root, 'node assert.cjs', {});
    check(failed.exit === 1, 'a real failure still comes back as a run for freeze, verify, gate and integrate to judge');
    const refused = await fails(() => runOracleCommand(root, 'node instrument.cjs', { instrumentExitCodes: [2] }));
    check(refused.includes('VERIFICATION_INFRASTRUCTURE') && refused.includes('No product verdict'), 'THE measured divergence: a declared instrument exit produces no product verdict at the one place every path runs commands through');
    check(refused.includes('instrument_exit_codes'), 'and the retry hint names the declaration to revise if that exit really is about the code');
    check((await runOracleCommand(root, 'node instrument.cjs', {})).exit === 2, 'the same exit without a declaration is still an ordinary non-zero result');
    // The gate, integration and stop do not run an ORACLE: they run the
    // deployment's DoD / whole-suite / green-build command. Same declaration,
    // read from config (pair_stop spreads config into this call), same refusal.
    const declaredConfig = { dodCommand: 'node instrument.cjs', instrumentExitCodes: [2] };
    const declaredRun = await fails(() => runDodCommand(declaredConfig, root, undefined, undefined, {}));
    check(declaredRun.includes('VERIFICATION_INFRASTRUCTURE') && declaredRun.includes('No product verdict'), 'a declared instrument exit is refused identically by the DoD/whole-suite/stop command path, so no gate fail and no red-build verdict is charged for it');
    const plainConfig = { dodCommand: 'node assert.cjs' };
    check((await runDodCommand(plainConfig, root, undefined, undefined, {})).exit === 1, 'while an undeclared ordinary failure still comes back as a run for the gate to judge');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  /* ---- the tool paths feed the declaration to that one runner ------------- */
  // The runner checks above prove the classification; these prove the two tool
  // paths that produce a verdict actually carry the declaration into it. A
  // declared exit 2 must not seal an oracle, must not become a REJECT and must
  // not be charged to the cycle — while the SAME exit without the declaration
  // still is one.
  const oracleFile = '.pair-oracles/t-1/instrument.cjs';
  const oracleCmd = 'node ' + oracleFile;
  const toolFixture = async ({ frozen }) => {
    const dir = await mkdtemp(join(tmpdir(), 'pair-instrument-tool-'));
    await mkdir(join(dir, '.pair-oracles', 't-1'), { recursive: true });
    await writeFile(join(dir, oracleFile), "console.error('PREREQ: pool link unavailable');process.exit(2);");
    const sha = await digestOracleFiles(dir, [oracleFile]);
    const protocol = initialProtocolState();
    const task = { id: 't-1', subject: 'repair', dependencies: [], status: frozen ? 'in_progress' : 'pending', assignee: 'driver', attemptId: 'attempt-1', createdAt: 1, updatedAt: 1 };
    if (frozen) {
      const cycle = openCycle(protocol, 't-1', { tddMode: 'enforce', oracleSha: sha });
      Object.assign(cycle, { step: 'GREEN', owner: { memberId: 'drv', assignee: 'driver', attemptId: 'attempt-1' },
        proposal: { files: [oracleFile], verify_plan: oracleCmd }, review: { verdict: 'go', auto: true, at: 2 },
        red: { evidence: ['baseline red'], at: 1 }, green: { evidence: ['green'], at: 3 },
        report: { diff_summary: 'repair', test_results: 'green', at: 3 } });
      task.oracle = { sha, files: [oracleFile], cmd: oracleCmd, frozenAt: 1, forks: 1, caseRefs: [], instrumentExitCodes: [2] };
    }
    const team = { id: 'ix', name: 'instrument', goal: 'measure', mode: 'light', tddMode: 'enforce', captainSessionId: 'cap',
      createdAt: 1, updatedAt: 1, members: [{ id: 'drv', name: 'driver', role: 'driver', status: 'idle', joinedAt: 1 }, { id: 'nav', name: 'navigator', role: 'navigator', status: 'idle', joinedAt: 1 }],
      tasks: [task], taskSeq: 1, protocol };
    const config = { stateDir: '.state', evidenceCache: false, tddMode: 'enforce', maxCyclesPerTask: 20 };
    const defs = [];
    const ctx = { logger: { warn() {}, debug() {}, error() {} }, tools: { register: d => defs.push(d) }, agents: { get: () => undefined }, subagents: { sendMessage: async () => 'm' } };
    registerFlowTools(ctx, config, { scheduler: {} }); registerOracleTools(ctx, config);
    const stateRoot = join(dir, '.state');
    await createTeamDir(stateRoot, team);
    return {
      dir, stateRoot, cycleId: protocol.cycles[0]?.id,
      board: () => readTeam(stateRoot, team.id),
      edit: async (fn) => { const fresh = await readTeam(stateRoot, team.id); fn(fresh); await writeTeam(stateRoot, fresh); },
      call: (name, args) => defs.find(d => d.name === name).execute(args, { agent: { id: name === 'pair_oracle' ? 'nav' : 'nav', session: { header: { cwd: dir }, append() {} } } }),
      cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    };
  };

  const freezing = await toolFixture({ frozen: false });
  try {
    const sealed = await fails(() => freezing.call('pair_oracle', {
      task_id: 't-1',
      readings: ['the runner reports a missing prerequisite as its own outcome', 'the runner reports a missing prerequisite as the suite result'],
      chosen_reading: 'the runner reports a missing prerequisite as its own outcome',
      divergence_candidates: ['a hidden runner may not separate the two'],
      oracle_files: [oracleFile], oracle_cmd: oracleCmd, instrument_exit_codes: [2],
    }));
    check(sealed.includes('VERIFICATION_INFRASTRUCTURE') && sealed.includes('instrument_exit_codes'), 'the freeze refuses to seal an oracle whose RED is a declared instrument failure, and says which declaration to revise: nothing is written to the task contract');
    check((await freezing.board()).tasks[0].oracle === undefined, 'and no oracle is sealed from a measurement that did not run');
    const misdeclared = await fails(() => freezing.call('pair_oracle', {
      task_id: 't-1',
      readings: ['the runner reports a missing prerequisite as its own outcome', 'the runner reports a missing prerequisite as the suite result'],
      chosen_reading: 'the runner reports a missing prerequisite as its own outcome',
      divergence_candidates: ['a hidden runner may not separate the two'],
      oracle_files: [oracleFile], oracle_cmd: oracleCmd, instrument_exit_codes: [0],
    }));
    check(misdeclared.includes('not redefinable'), 'a declaration that would make success mean "no verdict" is refused at the freeze');
  } finally {
    await freezing.cleanup();
  }

  const verifying = await toolFixture({ frozen: true });
  try {
    const refused = await fails(() => verifying.call('pair_verify', { cycle_id: verifying.cycleId, beyond_request: 'nothing', preexisting_at_risk: 'nothing' }));
    check(refused.includes('VERIFICATION_INFRASTRUCTURE') && refused.includes('No product verdict'), 'pair_verify refuses a declared instrument exit instead of computing a verdict from it');
    const afterRefusal = await verifying.board();
    check(afterRefusal.protocol.cycles[0].verify === undefined && afterRefusal.protocol.stats.reject === 0 && afterRefusal.protocol.cycles[0].rejections === undefined, 'and the cycle keeps its step, its rejection budget and the board its failure count');
    await verifying.edit((fresh) => { delete fresh.tasks[0].oracle.instrumentExitCodes; });
    const judged = await verifying.call('pair_verify', { cycle_id: verifying.cycleId, beyond_request: 'nothing', preexisting_at_risk: 'nothing' });
    const afterJudgement = await verifying.board();
    check(judged.verdict === 'reject' && afterJudgement.protocol.stats.reject === 1, 'while the same exit WITHOUT the declaration is still a product REJECT, charged as one');
  } finally {
    await verifying.cleanup();
  }
}