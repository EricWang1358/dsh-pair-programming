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
import { commandShapeError, isRunnableCommand, notRunnableEvidence } from '../lib/protocol/command-shape.js';
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
  check(badDod !== undefined && badDod.includes('dodCommand'), 'a prose dodCommand is refused at the settings boundary, not at the gate');
}
