# Native DSH acceptance — correctness refactor

The user requires actual DSH validation and selected OpenCode Go / `muse-spark-1.3-contributor`. Its configured provider on this machine is `opencode-go-muse`. An internal regression test with mock agents is not native acceptance.

## Runtime and evidence boundaries

- Profile: `pair-dev`, bundling real DSH base + headless + the plugin linked to this checkout. Installed DSH cohort: `0.1.2-rc.1`.
- A fresh process reads the current plugin source. No running user host is restarted. No default model settings are written.
- `scripts/dsh-smoke-runner.mjs` replaces only the headless entry point using a process-local overlay. It calls the real agent registry, creates a real session with an explicit model selection, and lets the real agent loop invoke the registered tools. It records route metadata, tool names, failures, child session IDs and the persisted terminal board.
- With `DSH_PAIR_SMOKE_EXPECT_TEAM`, the runner waits for the team to become DONE or ABORTED. The stock headless runner's first captain idle edge is not sufficient: children may still be running. The observer never writes the board and sends no continuation nudges.
- Hard timeout: ten minutes by default; at most thirty minutes. A timeout is a failed/incomplete run. A normal captain answer alone is not proof that the task or team completed.
- This is a small functional integration check, not a measured improvement in general repair success rate. The proposed held-out comparative experiment is in the research report.

## Measured preflight and lifecycle

1. Explicit model preflight returned `DSH_MUSE_GO_OK`; captain session `session-aa58ada0-7b0a-418f-a92e-2c39f517473b`.
2. Lifecycle run: captain `session-c0b297b0-f6ca-47f0-9ce5-9cf6f36edc23`; child sessions `61f9b21a-fbc4-492e-b96a-bf550661acb1` and `c118e473-7afd-458f-9215-f4374af18887`. Real `pair_start`, `pair_status` and `pair_stop(outcome="aborted")` executed. The board records two retired members and ABORTED. Both members used the requested provider/model. This intentionally had no implementation task and does not count as a successful repair.

Test-only runner setup errors were corrected before these measurements: overlay rows cannot change an existing entry's package name (disable the old entry and insert a new one); Windows ESM entry names require a `file:///` URL; a setup callback must not return the model-selection helper's value as an AgentSetupCommit. The first attempted override did not take effect and is excluded from the specified-model evidence.

## Reproduction setup

Requirements: a local DSH headless profile which already loads this linked plugin and has the requested model route. The runner uses existing host dependencies; it does not provision credentials. Keep fixture, overlay and result paths separate from the source checkout.

The overlay is a YAML patch list; replace the URI with this checkout's actual absolute runner URI:

```yaml
- id: headless-runner
  disabled: true
- insert:
    - id: pair-native-smoke-runner
      name: 'file:///D:/A/1NUS/1Sem/dsh-better-pairprograming/dsh-pair-programming/scripts/dsh-smoke-runner.mjs'
      inject: [headlessStartup]
      config:
        task: !!js ctx.headlessStartup.task
```

In a terminal whose working directory is the isolated fixture:

```powershell
$env:DSH_PAIR_SMOKE_PROVIDER = 'opencode-go-muse'
$env:DSH_PAIR_SMOKE_MODEL = 'muse-spark-1.3-contributor'
$env:DSH_PAIR_SMOKE_OUTPUT = 'C:/absolute/test-results/repair.json'
$env:DSH_PAIR_SMOKE_EXPECT_TEAM = 'native-repair'
$env:DSH_PAIR_SMOKE_TIMEOUT_MS = '600000'
dsh --profile pair-dev --patch 'C:/absolute/test-results/runner.patch.yml' (Get-Content -LiteralPath 'C:/absolute/test-results/repair-prompt.txt' -Raw)
```

The repair fixture exposes `parseRange(text)`, preserving integer, negative and equal-endpoint behavior plus invalid-syntax TypeError. Its seeded defect accepts reversed endpoints; the requested repair must throw RangeError. Five pre-existing regression checks pass on the buggy baseline. The Navigator must create and freeze an additional behavioral oracle through DSH, then the Driver implements, the Navigator verifies, and the captain completes the actual gate/retro/stop chain.

## Intermediate repair after U3

Actual requested-model run completed in **210.085 seconds**, with 71 recorded tool calls and five session identities (including two replacement member identities). Captain: `session-29d5a694-07cc-460c-b69a-82be9a5d020f`. The board is DONE, task t-1 completed, its latest cycle has computed final ACCEPT, and both final members are removed. Gate credential: `1eab0a46-bc9b-4f8f-a774-2878e0dc446b`. The recorded calls include oracle write/freeze, propose, GREEN, verify, gate, completion, retro and stop. All recorded routes use the requested provider/model. Compact receipt: [native-u3-repair.json](evidence/native-u3-repair.json).

The actual production change is one lower>upper guard after syntax validation. Parent independently read the production and generated oracle files, ran the unchanged five-case regression suite, and checked an additional reversed case `9..-3`; all passed. The generated oracle checks seven behavioral cases plus the regression command, and its freeze records a failing baseline. One `FS_NOT_OBSERVED` edit failure occurred and was recovered; it is retained in the receipt. Driver-side sandbox restrictions affected its direct nested regression probe, while the plugin's actual oracle replay and stop command succeeded. This is an integration observation, not a claim that every tool ran without errors.

This run preceded final U2b integration and is labelled intermediate. Final native acceptance uses a fresh fixture with two independently specified fixes (range and clamp), eight preserved baseline regressions, separate task oracles and two gate credentials. Its results and integrated fault checks are recorded below after execution.

## Final acceptance after full integration — FAILED

Run on the integrated tree (`802bfd7`), fresh fixture, requested provider/model, **453.3 seconds, 140 tool calls, nine session identities**, captain `session-e95e7d87-a286-4d49-970e-67a6bb0bd596`. Every recorded route used `opencode-go-muse` / `muse-spark-1.3-contributor`. Compact receipt: [native-final-two-task.json](evidence/native-final-two-task.json).

The fixture seeds two independent defects in one module: `parseRange` accepts a reversed range, and `clamp` ignores its upper bound. Its eight baseline regressions pass on the buggy baseline and exercise neither defect.

What the protocol did correctly. Two use cases became two tasks. The Navigator authored one oracle per task under `.pair-oracles/<task>/`, each importing the real product module, each frozen only after failing on the tree of the day; the t-2 freeze at `1788811173300` is itself evidence that `clamp` was still broken after t-1 closed. Both cycles carry a computed final ACCEPT (`oracle_green`, exit 0) at `1788811143893` and `1788811285583`, and the two tasks carry two distinct gate credentials, `61bb305f-…` and `7577eea4-…`. No REJECT, NO_GO or risk was recorded.

Why the run failed — a closure deadlock, not a captain mistake. The board is `ABORTED` and no completion receipt exists. Both tasks edit the same file, so t-2's implementation moved the worktree out from under t-1's gate credential, and `pair_stop(outcome="complete")` refused, naming the remedy in its own text: `gate credential stale against the final worktree … — re-run pair_gate_check`. The captain followed that instruction. The recorded call order is `pair_retro` → `pair_stop` → `pair_gate_check` → `pair_status` → `pair_gate_check` → `pair_stop` → `pair_stop` → `write` → `pair_start`: two re-gate attempts between three refused stops. Only then did it write `src/range.mjs` back to the seeded baseline and file a replacement team `native-final-2`, still in `PLANNING` when the observer stopped at the terminal phase of the team it was watching.

The re-gate cannot succeed. `pair_gate_check` opens with `captureEvidenceBoundary` → `requireLiveEvidenceTarget`, which refuses any task whose status is `completed`, `failed` or `cancelled`. Replaying this run's own `team.json` against the tool confirms it directly:

```
t-1 (status=completed) => THREW: VERIFICATION_STALE: task is terminal or no longer exists
t-2 (status=completed) => THREW: VERIFICATION_STALE: task is terminal or no longer exists
```

So the sequence closes on itself: completing t-1 binds its credential to worktree W1; t-2's implementation moves the tree to W2; `pair_stop(complete)` demands a credential bound to W2; and the tool that issues credentials refuses the only task that needs one. **Any board with more than one task, where a later task changes the tree — which is what implementing it means — cannot be stopped as complete.** The stop refusal prescribes a call the runtime rejects. `requireLiveEvidenceTarget` and its use in the gate arrived with the review-binding work in `0a64dc2`; the mocked suites never gate a completed task, which is why 1325 green checks did not see it.

The product state was verified independently afterwards, not read off the board: `src/range.mjs` is byte-identical to the seeded fixture, both frozen oracles replay RED (`parseRange('9..3')` returns a range; `clamp(99,1,10)` returns 99), and the eight baseline regressions still pass. **Two repairs were computed, accepted and gated, and then discarded when the captain reset the fixture to retry.** This run certifies the protocol chain under a real host and a real model, and refutes any claim of a successful two-task repair.

## Runs 2 and 3, after the closure repairs — still not closed

Two further runs on the same two-defect fixture, fresh workspace each time, same provider/model, `1500` and `1800` second caps. **In both, the model produced both repairs correctly**: `parseRange` throws `RangeError` on a reversed range, `clamp` returns its upper bound, all eight baseline regressions still pass, both tasks reach `completed` with distinct credentials and both cycles carry a computed final ACCEPT. Both runs then **timed out in `RETRO` with no completion receipt**. The repair is not what fails; closure is.

Run 2 confirmed the reach repair on a live board: both frozen oracles recorded `reach: {selfContained: false, touches: ['src/range.mjs']}`, where the same oracles had been reported SELF-CONTAINED before.

Run 2's blocker was the next layer of the same fault. `pair_stop` requires `RETRO` before it will complete a board and then demands a credential bound to the final worktree — but `requireLiveEvidenceTarget` refused every call once the phase was `RETRO`, because `isDispatchClosed` counts it as closed. That predicate answers "may a seat still be woken"; closure evidence is a different question. Recorded order: `pair_retro` → `pair_stop` → `pair_gate_check` → `pair_stop`. Repaired in `c954802`: closure calls refuse only `DONE` and `ABORTED`.

Run 3 reached the layer after that. The gate now runs in `RETRO`, and re-certification is refused for a new reason. Replaying run 3's own final board and tree:

```
stop failures: completed task(s) have a gate credential stale against the current board: t-1 — re-run pair_gate_check
               completed task(s) have a gate credential stale against the final worktree: t-1 — re-run pair_gate_check
t-1 => THREW: GATE_STALE: the latest final review does not bind the current candidate, board and task attempt …
```

Re-certification requires the review's `gateStateSha` to equal `reviewStateFingerprint` on the current board, and that fingerprint includes the task's arbitration decisions. The captain, trying to settle the impasse the documented way, recorded exactly one ruling — `d-6c21cb3b`, conflict ref *"t-1 gate stale after t-2 edit"* — and the act of ruling on the stale gate moved t-1's board fingerprint and tightened the knot it was meant to loosen. The board carries two cycles, two accepts, no risks, and that single decision.

The pattern across three runs is one design fault, not three bugs: **`gateStateFingerprint` answers "did anything on this task's board change" and is used to decide "does the reviewer's judgment about the code still stand".** Everything that happens after a review — another task landing, a phase moving to RETRO, a captain recording a ruling — changes the first and is taken to invalidate the second, while `pair_stop`'s remedy is a call whose own preconditions those same events destroy.

The last layer is sharper than it looks. Re-certification cannot bind to the live task attempt at all, because `scheduler.js` releases `attemptId` the moment a task goes terminal: completion destroys the field the check needs. The identity that does survive is the chain from the final review to the credential the task still holds — both recorded while the attempt was live, both naming it. `296c5f2` binds re-certification to that chain, carries the original attempt forward on a re-issued credential so the next re-certification can still verify it, and lets the gate's own checklist speak for everything it re-evaluates anyway: the frozen oracle, scope, deliverables, blocking risks, documented decisions, and `all_accepted`, which fails on its own the moment a new cycle opens on the task.

Replaying all three stuck boards against that repair: every stale-credential obstacle clears, and the two boards whose product is genuinely repaired gate green. The first, whose product had been reverted, correctly fails its oracle replay instead.

## Run 4 — acceptance PASSED

Same fixture, same provider/model, fresh workspace. **225.2 seconds, 89 tool calls, seven session identities**, captain `session-a7d638d0-31a0-4e8b-9738-045815f5466f`; every recorded route on `opencode-go-muse` / `muse-spark-1.3-contributor`. Compact receipt: [native-close2-pass.json](evidence/native-close2-pass.json).

The board is `DONE` with completion receipt `pair-complete:2968ccfe…`. Two tasks completed on two distinct credentials, both cycles computed final ACCEPT, both oracles recorded `reach: {selfContained: false, touches: ['src/range.mjs']}`, both members retired. Three gate passes exist and **two carry `recertified: true`** — the re-certification path is not incidental here, it is what closed the board. The stored green build is `node tests/regression.mjs`, exit 0, eight of eight.

Verified independently of the board afterwards: `parseRange('9..3')` throws `RangeError` while `'4..4'` and `'3..9'` still parse and `'abc'` still throws `TypeError`; `clamp(99,1,10)` returns 10, `clamp(-2,1,10)` returns 1, `clamp(5,1,10)` returns 5; both frozen oracle commands replay green from the workspace; the eight baseline regressions pass unchanged.

This is a functional integration result on one model and one host — two specified repairs carried through oracle freeze, independent review, gate, re-certification, retro and a receipted stop. It is not a measured improvement in general repair success rate; that experiment remains the held-out comparison in the research report.

### Defect found by this run: oracle reach is blind to a relative import

Both freezes recorded `reach: {selfContained: true, touches: []}` for oracles that import `../../src/range.mjs`. `assessOracleReach` (`lib/tools/oracle-exec.js`) collects quoted path-like tokens and resolves each one **against the workspace root**, so an oracle's own relative import escapes the workspace and is dropped. Oracles live under `.pair-oracles/<task_id>/`, so a relative import is the normal way to reach the product: the warning that exists to expose a tautological oracle fires on correct ones instead, and `SELF-CONTAINED (asserts nothing about existing code)` was printed about two oracles that were asserting exactly the right thing. Not repaired in this batch.
