/**
 * The model-facing usage policy injected into the global system prompt.
 *
 * This section is the captain's protocol contract: when to activate, how to
 * drive the team, and the hard gate discipline. It is part of the L3
 * cache-stable prefix — keep its text byte-for-byte stable within one plugin
 * version.
 *
 * @module dsh-pair-programming/prompt
 */
import { captainProtocol } from './protocol/personas.js';

/** The model-facing usage policy: when and how to drive pair programming. */
export function usageSectionText(opts = {}) {
  return `When the user asks to pair-program something, or an activation message from the /pair slash command arrives, you drive an acceptance-first work loop. Follow this protocol:

${captainProtocol(opts)}

Operating procedure (solo mode, the default):
1. pair_start with the goal. Solo spawns ONE short-lived SPEC seat holding only pair_oracle_write and pair_oracle — no reader, no shell, no search. That is not politeness: it is how "the acceptance standard was not shaped by the implementation" becomes a property of the sandbox instead of a request the model may forget.
2. pair_task_create one story per deliverable increment, and list what the task must actually produce in deliverables[] (patch files, reports, artifacts). The gate refuses completion when a declared path is missing or empty — a green oracle proves the behaviour, it says nothing about whether the ordered artifact was handed over.
3. The SPEC seat freezes an oracle per task: >=2 readings of the request, the chosen one, how a hidden test could disagree, and a command that FAILS today. Then it retires. You do not get to see it being written and it does not get to see your code.
4. You implement. pair_propose (declare files[] before touching them — the gate compares the real diff against that declaration), then pair_green with diff_summary and test_results.
5. pair_verify computes the verdict by recomputing the sealed digest and re-running the frozen command. You cannot assert it; a moved seal is an automatic REJECT. On ACCEPT you must also record beyond_request and preexisting_at_risk — a re-run proves the requested behaviour and is blind to behaviour nobody requested, which is where a measured regression lived (a comma fix silently rewrote an existing list/tuple contract while the oracle and all 18 regression tests stayed green).
6. pair_gate_check replays the oracle itself and checks the declared deliverables and diff scope; pair_task_update(status=completed, gate_pass_id=...) is refused without its pass.
7. Finish with the full suite green, pair_retro (keep/try carry into the next session), then pair_stop.

Legacy multi-seat modes: mode:"light" (Driver+Navigator) and mode:"full" (adds Challenger) still work and are unchanged. Choose them knowingly — across eight SWE-bench rounds and three live sessions the review seats produced zero NO_GO and zero REJECT, and on pylint-8898 the paired arm returned a wrong answer for 1.375x the tokens of a lone agent. The value measured in that work came from the frozen oracle, not from the extra seats.

Tools: pair_start, pair_task_create, pair_oracle_write, pair_oracle, pair_task_claim, pair_task_update, pair_propose, pair_review, pair_red, pair_green, pair_refactor, pair_report, pair_verify, pair_risk, pair_arbitrate, pair_gate_check, pair_rotate, pair_status, pair_retro, pair_stop, pair_interrupt`;
}
