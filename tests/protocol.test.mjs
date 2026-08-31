/** protocol layer: messages DSL, machine, personas (pure logic). */
import { encodeMessage, decodeMessage, missingFields, isProtocolMessage, feedbackProblems, MESSAGE_TYPES } from '../lib/protocol/messages.js';
import { initialProtocolState, openCycle, granularitySignal, cycleBudgetExhausted, phaseTransitionError, cycleStepError, cycleChain, cycleBudgetForTask } from '../lib/protocol/machine.js';
import { captainProtocol, driverPersona, navigatorPersona, challengerPersona, PROTOCOL_VERSION } from '../lib/protocol/personas.js';

export async function run(check) {
  // messages
  const enc = encodeMessage('PROPOSE', { cycle_id: 'c1', intent: 'x', files: ['a.js'], verify_plan: 'npm test' });
  const dec = decodeMessage(enc);
  check(dec.type === 'PROPOSE' && dec.body.intent === 'x', 'messages roundtrip');
  check(isProtocolMessage(enc), 'messages isProtocolMessage true');
  check(decodeMessage('hello world') === undefined, 'messages non-protocol -> undefined');
  check(missingFields('PROPOSE', dec.body).length === 0, 'messages no missing fields');
  check(missingFields('PROPOSE', { cycle_id: 'c1' }).includes('intent'), 'messages missing field detected');
  const lenient = decodeMessage('[PAIR:GO]\nnot json');
  check(lenient.type === 'GO' && lenient.rawBody === 'not json', 'messages lenient decode');
  check(MESSAGE_TYPES.includes('ARBITRATE'), 'messages ARBITRATE type exists');
  check(['RED', 'GREEN', 'REFACTOR'].every(t => MESSAGE_TYPES.includes(t)), 'messages TDD types exist');
  check(missingFields('RED', { cycle_id: 'c', test_files: ['a_test.js'] }).includes('red_evidence'), 'messages RED needs red_evidence');
  check(missingFields('NO_GO', { cycle_id: 'c', required_changes: 'x' }).includes('feedback'), 'messages NO_GO requires structured feedback');
  let threw = false;
  try { encodeMessage('BOGUS', {}); } catch { threw = true; }
  check(threw, 'messages unknown type throws');

  // feedback triad
  check(feedbackProblems({ observation: 'line 42 indexes past the empty array', impact: 'production crashes on the first request', way_forward: 'guard isEmpty and add a regression test' }).length === 0, 'messages good triad accepted');
  check(feedbackProblems({ observation: 'x', impact: 'y', way_forward: 'z' }).length === 3, 'messages parts below 8 chars rejected');
  check(feedbackProblems({ observation: 'line 42 indexes past the empty array', impact: 'production crashes on the first request' }).length === 1, 'messages missing way_forward rejected');
  check(feedbackProblems({ observation: 'line 42 is off', impact: 'it is bad', way_forward: 'make it better' }).length > 0, 'messages vague hedge rejected');
  check(feedbackProblems(undefined).length === 1, 'messages absent feedback rejected');

  // machine
  const p = initialProtocolState();
  check(p.phase === 'FORMING' && p.stats.noGo === 0, 'machine initial protocol');
  check(p.stats.reasons && typeof p.stats.reasons === 'object', 'machine reasons counters initialized');
  check(phaseTransitionError('FORMING', 'PLANNING') === undefined, 'machine FORMING->PLANNING ok');
  check(phaseTransitionError('FORMING', 'DONE') !== undefined, 'machine FORMING->DONE rejected');
  const c = openCycle(p, 't-1');
  check(c.step === 'PROPOSED' && p.currentCycle.id === c.id, 'machine openCycle');
  check(c.tddMode === 'off', 'machine openCycle default off');
  check(cycleBudgetExhausted(p.cycles, 't-1', 1), 'machine budget exhausted at cap 1');
  check(!cycleBudgetExhausted(p.cycles, 't-1', 5), 'machine budget not exhausted');
  check(cycleStepError(c, 'PROPOSED') === undefined, 'machine step reset to PROPOSED allowed');
  check(cycleStepError(c, 'CLOSED') !== undefined, 'machine cannot jump straight to CLOSED');
  check(granularitySignal(p.cycles).signal !== 'enlarge', 'machine no enlarge on fresh');

  // machine: TDD chains
  const tdd = openCycle(p, 't-2', { tddMode: 'enforce' });
  check(cycleChain(tdd)[2] === 'RED', 'machine enforce chain includes RED');
  check(cycleStepError(tdd, 'RED') !== undefined, 'machine enforce cannot skip GO (PROPOSED->RED not adjacent)');
  check(cycleStepError({ ...tdd, step: 'GO' }, 'IMPLEMENTED') !== undefined, 'machine enforce cannot report straight after GO');
  check(cycleStepError({ ...tdd, step: 'GO' }, 'RED') === undefined, 'machine enforce GO->RED');
  check(cycleStepError({ ...tdd, step: 'RED' }, 'GREEN') === undefined, 'machine enforce RED->GREEN');
  check(cycleStepError({ ...tdd, step: 'GREEN' }, 'VERIFIED') !== undefined, 'machine enforce cannot skip REFACTOR');
  check(cycleStepError({ ...tdd, step: 'REFACTOR' }, 'VERIFIED') === undefined, 'machine enforce REFACTOR->VERIFIED');
  const coach = openCycle(p, 't-3', { tddMode: 'coach' });
  check(cycleStepError({ ...coach, step: 'GO' }, 'IMPLEMENTED') === undefined, 'machine coach allows legacy report path');
  check(cycleStepError({ ...coach, step: 'GO' }, 'RED') === undefined, 'machine coach allows TDD path');
  const trivial = openCycle(p, 't-4', { trivial: true });
  check(cycleChain(trivial).includes('IMPLEMENTED') && !cycleChain(trivial).includes('RISK_CHECKED'), 'machine trivial chain is the short loop');
  check(cycleStepError({ ...trivial, step: 'GO' }, 'RED') !== undefined, 'machine trivial cannot enter TDD chain');
  check(cycleBudgetForTask({ type: 'spike' }, { maxCyclesPerTask: 12, spikeMaxCycles: 2 }) === 2, 'machine spike gets the tiny timebox');
  check(cycleBudgetForTask({ type: 'feature' }, { maxCyclesPerTask: 12, spikeMaxCycles: 2 }) === 12, 'machine feature uses the session cap');

  // personas (L3 byte-stability + role semantics)
  const team = { id: 't', name: 'T', goal: 'g', protocol: p };
  const m = { name: 'driver' };
  check(driverPersona(team, m, '.pp') === driverPersona(team, m, '.pp'), 'personas driver prefix byte-stable');
  check(captainProtocol() === captainProtocol(), 'personas captain stable');
  const tteam = { ...team, tddMode: 'enforce', pairStyle: 'strong' };
  check(driverPersona(tteam, m, '.pp').includes('I7 Test first'), 'personas enforce carries I7');
  check(driverPersona(team, m, '.pp').includes('I7 Test first') === false, 'personas off omits I7');
  check(driverPersona(tteam, m, '.pp').includes('STRONG'), 'personas strong style');
  check(driverPersona({ ...team, pairStyle: 'ping-pong' }, m, '.pp').includes('PING-PONG'), 'personas ping-pong style');
  check(driverPersona({ ...team, tddMode: 'coach' }, m, '.pp').includes('TDD COACH'), 'personas coach hint');
  check(navigatorPersona(tteam, m, '.pp').includes('observation'), 'personas navigator feedback triad');
  check(navigatorPersona(tteam, m, '.pp').includes('work not done'), 'personas navigator YAGNI lens');
  check(challengerPersona(team, m, '.pp').includes('quadrants 3/4'), 'personas challenger quadrant coverage');
  check(captainProtocol({ tddMode: 'enforce' }).includes('green-build'), 'personas captain green-build rule');
  check(captainProtocol({ tddMode: 'enforce' }).includes('70%'), 'personas captain 70% rule');
  check(captainProtocol({ tddMode: 'enforce' }).includes('never a generic'), 'personas captain story capture duty');
  check(navigatorPersona(team, m, '.pp').includes('NEVER edit'), 'personas navigator read-only');
  check(challengerPersona(team, m, '.pp').includes('red team'), 'personas challenger adversarial');
  check(PROTOCOL_VERSION === '2', 'personas versioned at v2');
}
