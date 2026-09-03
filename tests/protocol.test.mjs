/** protocol layer: messages DSL, machine, personas (pure logic). */
import { encodeMessage, decodeMessage, missingFields, isProtocolMessage, feedbackProblems, MESSAGE_TYPES } from '../lib/protocol/messages.js';
import { initialProtocolState, openCycle, granularitySignal, cycleBudgetExhausted, phaseTransitionError, cycleStepError, cycleChain, cycleBudgetForTask, planningArbitrationsUsed, planBudgetExhausted, specFrozen } from '../lib/protocol/machine.js';
import { captainProtocol, driverPersona, navigatorPersona, challengerPersona, PROTOCOL_VERSION } from '../lib/protocol/personas.js';
import { usageSectionText } from '../lib/prompt.js';
import { raiseBudgetExhausted, raiseBudgetMessage } from '../lib/protocol/risks.js';

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
  check(c.step === 'PROPOSED' && p.cycles[p.cycles.length - 1] === c && p.currentCycle === undefined, 'machine openCycle');
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

  // risk raise budget: the cap rations OPEN non-P0 tickets across the team.
  const ticket = (id, severity, openedAt, status = 'OPEN') => ({ id, severity, status, openedAt });
  const register = (...rs) => ({ risks: rs });
  const run = (n, severity, start = 1) => Array.from({ length: n }, (_, i) => ticket(`r-${i}`, severity, start + i));
  check(raiseBudgetExhausted(register(), 15).exhausted === false, 'risks empty register is inside the cap');
  check(raiseBudgetExhausted(register(...run(14, 'P2')), 15).exhausted === false && raiseBudgetExhausted(register(...run(15, 'P2')), 15).exhausted === true, 'risks cap trips at exactly the limit, not before');
  check(raiseBudgetExhausted(register(...run(20, 'P0')), 15).exhausted === false, 'risks P0 tickets never count against the cap');
  check(raiseBudgetExhausted(register(...run(9, 'P1'), ...run(9, 'P2', 100).map(r => ({ ...r, status: 'CLOSED' }))), 15).exhausted === false, 'risks only OPEN tickets count');
  check(raiseBudgetExhausted(register(ticket('r-old-p1', 'P1', 1), ticket('r-new-p2', 'P2', 99)), 0).closeFirst[0].id === 'r-new-p2', 'risks name a P2 before an older P1');
  check(JSON.stringify(raiseBudgetExhausted(register(ticket('b', 'P2', 5), ticket('a', 'P2', 1)), 0).closeFirst.map(r => r.id)) === '["a","b"]', 'risks order oldest first inside a severity');
  check(JSON.stringify(raiseBudgetExhausted(register(ticket('z', 'P2', 7), ticket('a', 'P2', 7)), 0).closeFirst.map(r => r.id)) === '["a","z"]', 'risks break an openedAt tie by id');
  check(raiseBudgetExhausted(register(...run(9, 'P2')), 0).closeFirst.length === 5, 'risks refusal names at most five tickets');
  check([undefined, 0.5, -1, '15'].every(bad => { try { raiseBudgetExhausted(register(), bad); return false; } catch { return true; } }), 'risks a dirty cap throws instead of silently passing');
  check(raiseBudgetExhausted(register(), 0).exhausted === true, 'risks cap 0 freezes non-P0 raises (YAML kill switch)');
  const refusal = raiseBudgetMessage(raiseBudgetExhausted(register(ticket('r-9', 'P2', 1)), 15));
  check(refusal.includes('cap 15') && refusal.includes('r-9(P2)') && refusal.includes('P0 bypasses'), 'risks refusal is actionable and states the exemption');

  // planning arbitration budget: per task, anti-bypass attribution, time-windowed.
  const planProto = (decisions = [], cycles = []) => ({ decisions, cycles });
  const planDec = (id, extra = {}, at = 1) => ({ id, at, ...extra });
  check(planningArbitrationsUsed(planProto(), 't-1').count === 0 && planningArbitrationsUsed(planProto([planDec('d2', { conflictRef: 'plan t-1' })]), 't-1').count === 1, 'planning starts unspent and counts a conflictRef-only ruling (no task_id escape hatch)');
  check(planningArbitrationsUsed(planProto([planDec('d3', { conflictRef: 't-10' })]), 't-1').count === 0 && planningArbitrationsUsed(planProto([planDec('d3', { conflictRef: 't-10' })]), 't-10').count === 1, 'planning t-1 never borrows a t-10 ruling');
  check(planningArbitrationsUsed(planProto([planDec('d4', { taskId: 't-1', conflictRef: 't-1' })]), 't-1').count === 1 && planningArbitrationsUsed(planProto([planDec('d5', { taskId: 't-2' })]), 't-1').count === 0, 'planning counts a doubly-attributed ruling once and leaks no other task into the budget');
  check(planningArbitrationsUsed(planProto([planDec('d6', { taskId: 't-1' }, 50), planDec('d7', { taskId: 't-1' }, 150)], [{ taskId: 't-1', openedAt: 100 }]), 't-1').count === 1 && planningArbitrationsUsed(planProto([planDec('d8', { taskId: 't-1' }, 9), planDec('d9', { taskId: 't-1' }, 99)]), 't-1').count === 2 && planningArbitrationsUsed(planProto([{ id: 'd13', taskId: 't-1' }], [{ taskId: 't-1', openedAt: 100 }]), 't-1').count === 1, 'planning stops at the first cycle, counts all while none exists, and tightens on a missing at');
  const spent = planProto([planDec('d10', { taskId: 't-1' }), planDec('d11', { taskId: 't-1' })]);
  check([undefined, 0, 1.5, '2'].every(bad => { try { planBudgetExhausted(planProto(), 't-1', bad); return false; } catch { return true; } }) && planBudgetExhausted(planProto([planDec('d12', { taskId: 't-1' })]), 't-1', 2).exhausted === false && planBudgetExhausted(spent, 't-1', 2).exhausted === true && planBudgetExhausted(spent, 't-1', 2).pickSideRequired === true, 'planning refuses a 0 or dirty cap and trips exactly at the cap');
  const refusedPlan = planBudgetExhausted(spent, 't-1', 2).refusal;
  check(refusedPlan.includes('used 2 of 2') && refusedPlan.includes('d10') && refusedPlan.includes('pick a side'), 'planning refusal names the count, the cap, and the rulings');
  check(specFrozen(planProto([], [{ taskId: 't-1', openedAt: 5 }]), 't-1') === true && specFrozen(planProto([], [{ taskId: 't-1', openedAt: 5 }]), 't-2') === false && specFrozen(planProto([], []), 't-1') === false, 'planning freeze is per task, never the global phase');

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
  check(captainProtocol({ tddMode: 'enforce', defaultMode: 'light' }).includes('green-build'), 'personas captain green-build rule (legacy)');
  check(/red build/i.test(captainProtocol({ tddMode: 'enforce' })), 'the solo protocol still names the green-build gate it will actually hit');
  check(captainProtocol({ tddMode: 'enforce', defaultMode: 'light' }).includes('70%') && captainProtocol({ tddMode: 'enforce' }).includes('70%'), 'personas captain 70% rule in both modes');
  check(captainProtocol({ tddMode: 'enforce', defaultMode: 'light' }).includes('never a generic'), 'personas captain story capture duty (legacy)');
  check(captainProtocol({ tddMode: 'enforce' }).includes('as a user'), 'the solo protocol names the story validation the tool actually performs');
  check(navigatorPersona(team, m, '.pp').includes('NEVER edit'), 'personas navigator read-only');
  check(challengerPersona(team, m, '.pp').includes('red team'), 'personas challenger adversarial');
  check(['light', 'solo'].every(m => { const t = captainProtocol({ tddMode: 'enforce', defaultMode: m }); return t.includes('planningMaxArbitrations') && t.includes('exempt'); }), 'personas prose states the planning budget and its exemption in both modes');
  check(usageSectionText({ tddMode: 'enforce', defaultMode: 'light' }).includes('pair_interrupt') && usageSectionText({ tddMode: 'enforce', defaultMode: 'light' }).includes('current turn only'), 'usage prose names the interrupt hammer without over-promising (legacy modes, which have durable seats to interrupt)');
  // Solo has no durable seat to interrupt — the SPEC seat retires on its own.
  // Carrying the hammer text there would be describing a control for a party
  // that does not exist, which is the prompt bloat this mode set out to cut.
  check(!usageSectionText({ tddMode: 'enforce' }).includes('current turn only'), 'the solo protocol omits controls for seats it does not have');
  check(PROTOCOL_VERSION === '3', 'personas versioned at v3');
  // The granularity controller was dead: it filtered step==='CLOSED', which no
  // tool ever sets, so the enlarge branch could never fire in any real session.
  const acceptedCycles = [1, 2, 3].map((n) => ({ id: `c${n}`, step: 'VERIFIED', verify: { verdict: 'accept' }, rejections: 0, attacks: 0 }));
  check(granularitySignal(acceptedCycles).signal === 'enlarge', 'granularity: three accepted cycles now reach the enlarge branch (it keyed on an unreachable step before)');
  check(granularitySignal([...acceptedCycles, { id: 'c4', step: 'GO', rejections: 2 }]).signal === 'shrink', 'granularity: a twice-rejected live cycle still forces a smaller step');

}
