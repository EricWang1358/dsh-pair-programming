# Process audit

`node scripts/process-audit.mjs [repoRoot]` — the structural screens this project kept
redoing by hand, each one written because its class produced a real defect here.

| check | class it screens | the defect that motivated it |
|---|---|---|
| every kick/delivery site starts with a **workspace** | a `kickTeam` given a state root resolves `<ws>/.pair-programming/.pair-programming`, the readdir fails, and the wake-up is lost inside `.catch(() => undefined)` | F4: task creation woke nobody, silently |
| every `writeTeam` sits inside a **lock** | a writer that assumes the lock serialised it, but did not hold it | M14': a stale snapshot overwrote `DONE`, and `pair_stop` then reported a deadlock |
| a lib module **no test references** | the surface where the next defect waits | — |
| swallowed failures, counted | `.catch(() => undefined)` and empty `catch` blocks | a `ReferenceError` eaten by a caller's catch **silently stopped captain mail draining** |

Exit status is 0 when the structural checks are clean; the swallow count is reported for
comparison with `tests/swallow-baseline.json` (the guard's authority), and an untested module
is reported without failing, because the UI modules are exercised by the console workstream.

## Two blind spots, both of which produced a false reading before

1. **Optional chaining.** `kickTeam\\(` does not match `kickTeam?.(…)`, and the codebase uses
   the optional form whenever the scheduler may be absent. A first pass with the naive pattern
   missed five live sites and nearly produced an issue against **correct** code.
2. **A helper that takes the lock itself.** `commitMemberReplacement` holds the lock on the
   caller's behalf, so a write inside its callback is invisible to a textual scan of the
   enclosing function. The audit allows the helper by name and says so here.

## What it found on 2026-09-11

```
lib files:            80
kick sites checked:   15      all pass a workspace
writeTeam sites:      38      all inside a lock (37 textually, 1 via the helper)
swallowed failures:   36      baselined in tests/swallow-baseline.json
modules with no test: lib/runtime/panel-progress.js   (console/UI workstream)
structural checks:    clean
```

Re-run it after touching anything that wakes a seat, writes the board, or adds a module.

## Assertions: closed, and still blocked

Two cells have been closed since this section was written, and **both were declared blocked by me
without checking first**. That is the lesson this section now leads with.

**Closed — L2 at the seat.** `ce.test.mjs` asserts that the delivery a member reads names the skill
covering the call it owes, against a fixture that **proves itself first** (`owed.tool === 'pair_review'`).
Three attempts had measured nothing: I passed the slot that owed nothing, and I expected
`pair_propose → ce-ideate` when `ce-ideate` is a **user-surface** skill, so the lane correctly refused
to name it. Not a missing fixture — two wrong assumptions.

**Closed — the tool-level pause path (#75).** `backlog.test.mjs:171` already asserted it, and had since
an earlier round: a member's `pair_task_create` kicks with `background: true`, the captain's with
`false`, observed on the real call path. The "blocked" row below claimed the opposite because I looked
only at `parallel-tasks` and never searched for an existing assertion.

| cell | what it would assert | why it is blocked |
|---|---|---|
| credential projection (K2-5) | `pair_status.gate_credentials[].board_state_current` flips stale after a board move and back after a re-gate | `pair_status` throws on the synthetic board the verification suite can build |

## Before writing "blocked", search for the assertion

Twice in one session a cell was written down as blocked when it was not: once it was already asserted,
and once it needed a fixture that existed in a suite I had not looked at. The cheap rule that would
have caught both: **grep the tests for the thing you are about to call unasserted.** A record that
overstates the gaps is not conservative, it is wrong — and it teaches the next reader to avoid a cell
that is covered.

## The discipline that closed one of them

A fixture must **prove it produces the condition it exists for**, as its own assertion, before any
assertion that depends on it. Three attempts failed because the board owed nothing and the failure
looked like a product bug.

Shapes worth not re-deriving: `boundedMailboxPrompt(messages, team, recipient, config, pending)` takes
the recipient as a member **name**, `messages[].content` is a **string**, and it returns an object whose
**`.text`** is the prompt. `obligation.js:239` decides *who* owes: with `oracleFirst` an oracle-less task
owes `pair_oracle` to the **Navigator**, and the Driver owes `pair_propose` only when the task does not
need an oracle.
