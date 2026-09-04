# Changelog

All notable changes to `@ericwang1358/dsh-pair-programming` are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
protocol-level changes are versioned separately in `dsh.sdk.testedCohort` and
`PROTOCOL_VERSION`.

## [Unreleased]

## [0.4.1] — 2026-09-04 — the invariants stop being advisory

Five defects found by reading one live `full`-mode session end to end. Four of
them were rules the prompts state and the tooling did not actually enforce; the
fifth is a blind spot no re-run can cover.

### Fixed
- **P0 — I1 was defeated by a tool name we had not guessed.** A Challenger wrote
  three files into the workspace and ran PowerShell, on a host that registers its
  shell as `Pwsh`. The spawn filter intersected a list of guessed names with the
  registry (`CANDIDATES.filter(n => known.has(n))`), so it silently DROPPED every
  name it did not anticipate — it failed OPEN on exactly the host it had never
  seen, and threw only when the whole registry was unreadable. Non-Driver seats
  are now classified by SHAPE (`isWriteCapability`): any registered editor,
  patcher, writer or shell is denied whatever generation or casing it is named
  in. `run_code` stays exempt on purpose — it is the host's reserved transport
  name, `restrict()` throws on those, and a restricted child resolves its
  sub-dispatches against the same restricted map anyway.
- **P0 — and I1 now also holds at the call, not just at spawn.** The runtime path
  guard (`runtime/board-guard.js`) covered the captain; it now covers every
  non-Driver seat, denying workspace writes *and shells* by what the call would
  do rather than by what it is called. Shells stay open for the captain, which
  needs `git`; they do not for a review seat, which I1 says in as many words. A
  finished board (DONE/ABORTED) governs nobody — that stays the explicit,
  recorded escape hatch.
- **P1 — the sweep now wakes the seat that owes the step, not only the captain.**
  Measured: `Idle seats: driver, navigator, challenger. Mail pending for: driver,
  navigator, challenger.` — every seat idle, every seat with mail, 244s of
  nothing, twice. `deliverProtocolMessage` acknowledges the mailbox as soon as
  the host ACCEPTS a follow-up, so an accepted-but-inert follow-up leaves the
  debt standing with an empty inbox: the redelivery branch found nothing, the
  assignment branch found no ready task, and `kickMember` returned silently. The
  only recovery was `escalateIfStalled` steering the CAPTAIN — which is why that
  session had a captain hand-relaying every single step, the one thing its own
  protocol text forbids. `kickMember` now delivers the board's `[PAIR:NEXT]` line
  straight to the owing seat, in the second person, once per debt.

- **The host's own refusal now reaches the board, instead of a log nobody reads.**
  This is the root-cause layer under every stall above. `ctx.subagents.followup`
  refuses with a TYPED `SubagentError` — `DRAINING` while continuable subagents
  shut down, `ACTIVATION_CLOSING` mid-disposal — and `deliverToMember` swallowed
  it into a `logger.warn` and returned a bare `false`. `kickMember`'s redelivery
  branch then released the mail and returned having recorded **nothing**, so the
  sweep retried silently every 120s and the only artifact was a stall report
  that could not name a cause. That is precisely what two live sessions
  produced: `Mail pending for: driver, navigator, challenger`, 244s, and no why.
  `deliverToMember` now returns `{ ok, reason }`; every failure path records a
  decline; the stall report carries it verbatim under **Why the sweep could not
  clear it**; and the sending tool's own result gains `wake_refused`, because
  `delivered: "mailbox"` on its own reads like success to a model.

### Added
- **`pair_green(tuned_for_oracle)` — required.** Which values, thresholds, sizes,
  positions or counts were chosen so the ORACLE would pass rather than because
  the request asked. A computed verdict re-runs the sealed command and passes by
  construction; `beyond_request` asks what was done BEYOND the request, and
  tuning to the instrument is the opposite shape — the product made smaller,
  dimmer or moved so a threshold clears. Measured twice in one session: a rain
  effect dropped from 0.4 to 0.18 opacity "so the idle patches stay under the
  diff threshold", and a rain volume shrank from ±6 to ±4.85 after a footprint
  assertion failed, then was justified afterwards as "the correct look for a
  collectible miniature". Neither was visible anywhere on the board. Declarations
  surface on `pair_status` under **Tuned to the instrument** and reach the retro.
- **`pair_propose(why_not_split)` — required above the small-step threshold.** I2
  was prose once a proposal passed one file / 80 net lines: `net_lines` only ever
  decided whether the GO round was skipped, so an oversized cycle was merely one
  that waited. A measured cycle went through as three files, ~300 net lines and
  two plainly separate concerns, GO'd in a session whose review seat issued zero
  NO_GO. The tool still cannot judge "one concern" and does not pretend to — it
  makes the claim explicit, which is what gives a reviewer something to refuse.

### Changed
- **Captain prompts corrected to match the runtime.** Liveness now says the sweep
  wakes the owing seat directly, so a `[PAIR:STALL]` is information rather than a
  relay order; goal coverage must be read from `pair_status.goal_coverage` and
  never carried as a running count (a measured captain narrated "52/56" for
  several turns while its own arithmetic did not close).


## [0.4.0] — 2026-09-04 — solo by default; DONE has to be earned

Protocol v4. Two live sessions (`cec33cc5`) ended with a board reading `phase="DONE"`,
`cycles=[]`, `gatePasses=[]` and **0/10 tasks completed** — the captain had called
`pair_stop`, then built the product itself with 24 `write` and 51 `edit` calls outside the
protocol entirely, and the host goal accepted a hand-filled todo list as proof. Every rule
the protocol enforces was still true, and none of them applied, because none of that work
ever touched the board. v4 closes both ends of that escape and drops the seats that were
never doing the work. `PROTOCOL_VERSION` is now `4`.

**Breaking:** `defaultMode` is now `solo` (was `light`); `DONE` now means *the goal was met
and machine-checked*, not *the members were dismissed* — an incomplete board stops as
`ABORTED`; `pair_stop(outcome="complete")` requires `green_build_command` and executes it.

### Added
- **A requirement coverage matrix, frozen at `pair_start` (M17').** The goal is decomposed
  into `UC-N.AC-N` criteria on the board; `pair_task_create` binds cards to them through
  `acceptance_refs`, and the first cycle is mechanically refused while any criterion is
  unallocated. Enumerated request items can no longer be collapsed into one "UI complete"
  card that nobody can fail.
- **Completion receipts.** `pair_stop(outcome="complete")` is now a machine verdict: every
  task terminal, every completed task carrying its exact `gate_pass_id`, coverage 100%, no
  open P0/P1, RETRO done — and the plugin runs `green_build_command` itself, accepting only
  exit 0. Pasted "all tests pass" text is not evidence and never was. The returned
  `completion_receipt` is the only artefact that may close a host goal; an abandoned board
  stops as `ABORTED` and issues none.
- **The captain's write guard.** While a `full`/`light` team is live, the captain is denied
  workspace file mutations (`write`/`edit`/`apply_patch`/…): invariant I1 already gave those
  to the Driver, and this makes the sentence a property of the sandbox. Writes outside the
  workspace are untouched, shells are deliberately left open (a coordinator needs `git`), and
  the escape hatch is explicit — `pair_stop(outcome="aborted")`, which is recorded. Silent in
  `solo`, where the captain *is* the builder and the frozen oracle is what keeps it honest.
- **Member turn telemetry.** A seat's `lastTurn` records `startedAt`/`endedAt`/`endReason`/
  `toolCalls`/`boardMutations`/`lastError`. `idle` no longer flattens *finished*, *aborted by
  the parent* and *crashed* into one indistinguishable state — the reason two 480s and 300s
  Navigator turns looked like silence when they were actually parent-aborted mid-oracle.
- **A working lease (`workingLeaseMs`, default 600s).** A seat that is still emitting session
  events renews it, so a genuinely long turn is never called stalled; only an expired lease
  reaches the watchdog. Replaces wall-clock guessing about how long an oracle "should" take.
- **v4 solo protocol extraction.** `soloProtocol()` (under half the multi-seat text), `specPersona()` sandbox isolation, prompt-size budgets, and the `solo.test.mjs` suite: the default solo path is now independently pinned instead of implied.

### Changed
- **`defaultMode` is `solo`; `TEAM_MODES` lists cheapest first.** `light`/`full` remain
  supported and are documented with what they measured.
- **Captain re-entry is board-event driven, not goal-round driven (M18').** `wakeCaptain`
  replaces `steerCaptain`: a *running* captain gets a nearest-step steer, an *idle* one gets a
  real follow-up turn, deduplicated per `{team, board revision, obligation}`. Goal rounds were
  being spent as a wait clock — two pure waiting rounds cost 572,554 tokens and produced
  nothing, and the "wait two more rounds" they were spent on was 21 seconds long. The prompts
  now say plainly that a host goal holds the epic and completes only from the receipt, and
  that a schedule is a host-death watchdog, never a `pair_status` poller.
- **heartbeat sweep default 60s → 120s.** Worst-case stall bound is now ~120s (`0` still disables). Mailbox delivery lease stays 60s — separate mechanism, untouched.
- **settled teams leave the heartbeat sweep list.** All tasks terminal + all seats idle + no pending mail + nothing owed (or phase RETRO) → untrack: a finished team costs zero future sweeps and is never woken. Self-healing — kickTeam/kickMember/task-create/mailbox-recovery all re-track first — and fresh taskless teams never count, so pair_start's explicit track still protects protocols that stall before their first kick.

### Fixed
- **Cross-team zombie delivery.** Retired members are tombstoned for the live context and
  rehydrated from the durable deny-list at session start; generic host inbox inserts to a
  retired child are dropped and `deliverToMember` refuses outright. A re-fork instruction aimed
  at one team's Navigator landed in a *stopped* team's Driver log, under the same message id.
- **`pair_interrupt` is atomic.** It cancels the current turn *and* discards that seat's unread
  queue by default (`discard_queued=false` retains it), instead of leaving queued work to
  resume against a board that has moved on.
- **F4: task creation now wakes with the workspace.** `pair_task_create` passed the state root to `kickTeam`, which double-joined the state dir and silently woke nobody; new-task wake (and sweep-list re-track) works again, pinned by a wake-test regression.

## [0.3.0] — 2026-09-02 — protocol v3, oracle-first

Acceptance is derived before the implementation exists, and every verdict after that is a
re-execution. Driven by an eight-round measured comparison against a single-agent baseline
(`exp/capability-map/FINAL-EXPERIMENT-REPORT.md`) that found **zero correctness separation**
and one total loss; the full rationale, including what was removed and why, is in
`dsh-pair-programming-design/01-design/REDESIGN-v3.md`. `PROTOCOL_VERSION` is now `3`.

### Fixed
- **P0 single-writer bypass + stale completion receipts.** Non-Driver seats now lose generic
  shells (`pwsh`, `bash`, `Bash`) as well as file-editor tools. Navigator receives the narrow
  native `pair_oracle_write` capability instead: it writes only under
  `.pair-oracles/<task_id>/`, never production paths. A gate pass now binds the frozen oracle
  digest and final worktree fingerprint; `pair_task_update(status=completed)` rechecks both and
  rejects post-gate changes with `GATE_STALE`. Regression coverage proves production-path writes,
  oracle edits, and source edits cannot reuse the old credential.
- **P0 liveness — a stalled protocol no longer burns the timebox.** A protocol message whose
  live wake could not be delivered now schedules its own recovery kick, and a heartbeat sweeps
  tracked teams for stalled mailboxes (`heartbeatMs`, default 60s, `0` disables). The measured
  failure: a GO landed on the board, the Driver was never woken, and the run ended at the
  45-minute cap with a 0-byte patch. Pinned by `tests/wake.test.mjs`.

### Added
- **`pair_oracle_write`** — Navigator-only, bounded acceptance-artifact authoring before
  `pair_oracle` freezes the test. It replaces the unsafe need for a Navigator shell while
  preserving independent SPEC-FORK creation.
- **`pair_oracle` (SPEC-FORK, N1)** — the Navigator freezes a task's acceptance test derived
  from the request alone, before the Driver has an approach: at least two distinct readings of
  the request, the chosen one, how a hidden acceptance test could disagree with it, and the
  test itself. The tool runs the command and **refuses the freeze unless it fails today** — an
  oracle that already passes asserts nothing. The file set is sealed under a sha256 digest and
  becomes that cycle's RED, so the Driver never authors the standard it is judged against.
- **Computed verdicts (N2)** — on an oracle cycle `pair_verify` ignores the asserted verdict:
  it recomputes the digest, re-runs the frozen command, and derives accept/reject. A digest
  that moved is an automatic REJECT (`oracle_tampered`) whatever the oracle now prints.
- **The gate re-runs (N4)** — `pair_gate_check` replays the frozen oracle itself, and the new
  DoD items `oracle_precedes_impl` (the oracle predates the first cycle) and `oracle_replay`
  (the gate's own run passed) are on by default.
- **Board digest + per-cycle seats (R2)** — a seat is recycled on its own idle edge once its
  cycle is accepted and respawned from a bounded board digest (<=8k chars) instead of an
  accumulating transcript. `memberLifetime: session` restores v2 behaviour.

### Changed
- **Blocking risks close on an artifact, not a sentence (N3)** — a P0/P1 `pair_risk` close now
  requires `closing_cmd`, `closing_exit=0` and `closing_paths`, and is refused when every cited
  artifact is a file the team authored for this task. `MITIGATED` no longer clears the
  completion gate: only a confirmed close or an explicit WONTFIX does. Both measured escapes
  went out through this hole — one ticket named the exact defect that later failed the task and
  was closed against the team's own new tests.
- **`verify_evidence` is no longer a string count** — on an oracle task it requires a computed
  ACCEPT. The v2 check (`evidence.length > 0`) passed on both shipped-broken instances.
- **Default team is `light`** (Driver + Navigator). The Challenger seat produced no
  outcome-changing finding in eight rounds and filed zero attacks in one; its real
  contribution is now a required field of the SPEC-FORK, where the ticket it raises cannot be
  closed by assertion. `mode: "full"` still spawns it.
- **Small steps skip the GO round (R4)** — one file and <=80 net lines opens straight at GO;
  the GO round fired zero NO_GO across five single-file instances. Larger steps still wait, and
  the Navigator keeps REJECT authority at verification. A rejected auto-GO cycle rewinds to GO.
- **REFACTOR folds into GREEN on an oracle cycle (R5)** — `pair_green` now carries
  `diff_summary` / `test_results`; no separate round.
- **The Captain does not analyse the repository (R3)** — writing the story card from a
  root-cause briefing installs one interpretation into every seat at once, which is both the
  correlated-failure mechanism and the single most expensive thing a captain can do.


### Fixed — v3.1: the loop now drives itself (from two replayed v3 sessions)

Two complete v3 runs were replayed from their session transcripts. The v3
mechanisms all worked where they were invoked; what was missing is that nothing
made them happen. Measured:

| | session A | session B |
|---|---|---|
| captain `send_message` (prose "now do X") | 23 | **151** |
| `pair_propose` / `pair_green` | 3 / 3 | 28 / 35 |
| **`pair_verify`** | 3 | **0** |
| `pair_oracle` vs tasks | 3 / 3 | **1 / 10** |
| `pair_status` reads reporting `phase PLANNING` | all | **22 of 22** |

In session B the review seat took 2 turns while the Driver took 50, and 35
greens were never verified by anyone. The captain had become the scheduler.

- **The board now says whose move it is.** New `protocol/obligation.js` derives
  the single next call from the cycle step plus the task's oracle state, and a
  `[PAIR:NEXT] <who> owes <tool>(<id>) — <why>` line is appended to **every**
  protocol delivery and shown by `pair_status` and the board digest. Turn order
  is now read off the board instead of relayed by the captain, whose persona is
  explicit that announcing a turn is the most expensive and least reliable thing
  it can do.
- **Back-pressure: one unverified cycle per task.** `pair_propose` refuses while
  an earlier cycle of the same task has no verdict, naming who owes what. v3
  gated *completion* on verification but never *continuation*, which is how one
  Driver stacked 28 cycles against zero verdicts.
- **The session phase actually moves.** `advancePhase()` takes PLANNING→CYCLING
  when the first cycle opens, CYCLING→TASK_GATE on a gate pass, and back on
  completion. Previously only pair_start/retro/stop ever assigned a phase, so
  `CYCLING` and `TASK_GATE` were unreachable and every status read said
  `PLANNING` — including one that also said 3/3 tasks done.
- **No silent oracle bypass.** `type=spike` was exempt from oracle-first, and in
  session A all three tasks were spikes, so the gate never fired at all. A spike
  is no longer auto-exempt: it needs either an oracle or an explicit
  `no_oracle_reason`, which is recorded on the cycle and surfaced in status.
  `trivial` stays exempt outright.
- **Oracle reach.** All three of session A's oracles asserted only "does this
  probe file exist", against 12-byte files the Driver simply created — frozen
  RED, turned GREEN, and unable to detect anything about the code under review.
  `redProblem` cannot catch that (such an oracle really does fail today), so the
  freeze now reports its **reach**: whether the artifacts reference anything
  that already exists in the tree. `SELF-CONTAINED` is a loud warning carried in
  the freeze result, `pair_status`, the digest and the retro — a signal, not a
  refusal, because a spike whose deliverable really is a probe is legitimate.

### Fixed — conflicting sources of truth (audit pass)

A sweep for duplicated and contradicting authority, prompted by the v3 changes touching so
many of the same facts:

- **Configuration defaults had three declarations** (the `config.js` schema, the `??` chain in
  `apply()`, and the `settings.js` schema) and the mode/style enumerations had three more.
  Nothing kept them in agreement except attention — and the bug that motivated this whole
  redesign was exactly that shape: a `defaultMode` the settings UI showed and the lifecycle
  ignored. All of it now lives in `lib/defaults.js`; consumers import, none restate.
- **The oracle had two representations** — a `cycle.oracleSha` stamp and the live
  `task.oracle` record — that could silently disagree if the Navigator re-forked mid-cycle,
  judging work by a standard it was never shown. `resolveCycleOracle()` now refuses the
  mismatch instead of picking a winner, at verification and at the gate, and `pair_oracle`
  refuses to re-freeze while a cycle is in flight.
- **`pair_status` and the gate disagreed about "blocking"**: after MITIGATED became blocking,
  status still listed only OPEN tickets, so a captain could read "Open risks: none" while the
  gate refused the task. One predicate now feeds both, and status also reports each task's
  oracle state. `pair_propose` calls the shared `hasOpenP0()` rather than its own inline copy.
- **The legacy step tools gave actively wrong instructions on an oracle cycle** —
  `pair_report` told the Driver to use `pair_red -> pair_green -> pair_refactor`, which the
  oracle chain forbids. All three now refuse by naming the right move instead of emitting a
  chain error.
- **`RISK_CHECKED` and `CLOSED` were unreachable**: no tool has ever advanced a cycle past
  `VERIFIED`, so `granularitySignal` — which filtered `step === 'CLOSED'` — matched nothing
  and its enlarge branch could never fire. The adaptive granularity controller was dead in
  every measured run. It now keys on acceptance, shrink outranks enlarge (a cycle failing now
  beats three that went well before it), and the v3 chain no longer advertises steps nothing
  performs.
- **Contradictions inside one prompt**: I3 demanded a Navigator GO that R4's auto-GO skips;
  I7 told the Driver to author the failing test that N1 forbids it from authoring; the
  captain's CYCLING triggers named a REFACTOR message the v3 chain never sends; ping-pong
  style described alternating test authorship that oracle-first makes impossible. Each now
  states its own exception rather than leaving the model to reconcile two rules.
- **Stale version literals** (`0.2.x` in two descriptions, one pinned in a test assertion) and
  three inline copies of the workspace-resolution expression.
- **`heartbeatMs` was exposed as a live setting** although its interval is wired at `apply()`
  time; a knob that does nothing until restart is worse than no knob. It is YAML-only now,
  and both READMEs say so.

## [0.3.0] - 2026-09-02

The gate runs the verification command itself, stale receipts fold before offline delivery, and `pair_status` reads one board.

### Fixed
- **Configured `defaultMode` is now effective**: an omitted `mode` in `pair_start`
  now forms the configured `light` (Driver + Navigator) team instead of silently
  forcing `full`. An explicit mode still wins. This makes the documented fast lane
  usable for cost-sensitive work without weakening its TDD or Navigator checks.

### Added
- **Machine gate (M7')**: set `dodCommand` and `pair_gate_check` executes it in the workspace
  itself — outside the team lock, 120s constant timeout. Successes cache under a content digest
  of the whole workspace with the state dir excluded (cache writes cannot invalidate themselves;
  any changed byte reruns; failures never cache; an incomputable digest still runs, just
  uncached). A pass record carries `{command, exit, outputSha, cached}`; a failed run counts
  toward `gateFails` with the last 40 output lines attached. The command runs through the
  shell — a deployment-owner setting on the same trust boundary as `dod` / `memberProvider`.

### Changed
- **DSH alpha.5 compatibility**: test cohort advanced to `@deepseek-ai/dsh@0.1.2-alpha.5`.
  `schemastery` is now a direct runtime dependency, and linked installs repair a stale SDK
  junction before resolving host peer singletons.
- **Continuable members**: use descriptor-persisted `agentOptions` rather than the removed
  `registerContinuableSetup` extension point, including reasoning effort on cold resume.
- **Canonical board**: the current cycle in `pair_status` is derived from `cycles[]`
  (`currentCycleOf`) instead of a second stored pointer that JSON round-trips split from the
  array; a legacy `currentCycle` field is ignored, never migrated.
- **Delivery-time collapse**: offline backlog redelivery folds receipts whose effect is already
  on the board (GO/RED/GREEN/REFACTOR/ACCEPT judged against the cycle record) into one
  `[n absorbed by board: …]` line; live messages, non-protocol text and unknown cycles stay
  verbatim; claim/ack semantics untouched.

### Known gaps (tracked, not closed here)
- The gate proves the workspace passes at gate time; the per-step tree REFACTOR touched is not
  machine-judged yet (needs a GREEN-time snapshot, 0.3.x). Without `dodCommand`, verification
  evidence stays honor-system. Unchanged: rulings naming no task spend no budget, `failed` is
  unguarded, no scheduler backoff; pipeline/preemption wait for pending data.
### Tests
- 263 assertions across 9 suites; `npm run verify` is the release chain.

## [0.2.2] - 2026-09-01

Driven by a real team's dogfood session (deep arbitration pileups and a full risk register): the
captain now gets a hammer, a gauge, and two budgets that until then existed only as prose advice.

### Added
- **`pair_interrupt`** cancels one member's current turn and reports `delivered`; queued mailbox
  messages are not cleared by it. `pair_status` shows per-member `mailbox.pending`, where a
  delivery claimed inside its 60s lease is excluded — so 0 can mean "in flight", not "delivered".
- **Risk WIP budget** `maxOpenRisks` (default 15, team-wide): a P1/P2 raise is refused while the
  register is full, naming the oldest P2 tickets to clear; a P0 always goes through.
- **Planning budget** `planningMaxArbitrations` (default 2, per task): past it `pair_arbitrate`
  refuses and asks for a chosen side or a risk ticket; a task that already has a cycle is exempt,
  and cancelling a started task stays refused until the reason is recorded by `pair_arbitrate`.

### Fixed
- `verify-startup` diffs both directions (missing **and** unexpected tools) and reports the
  registered count instead of the expected one, so a new tool cannot slip past the gate unaudited.

### Known gaps (tracked, not closed here)
- A ruling that names no task spends no budget; `status=failed` is not guarded.
- settings→resolved is not proven at `apply()` level; M7'-M11' unchanged from 0.2.1.
### Tests
- 239 assertions across 8 suites; every captain-facing sentence about the two budgets and the
  interrupt is pinned by a test that reads the rendered prose, so docs cannot drift ahead of code.

## [0.2.1] - 2026-09-01

Hot fix: teams form on any DSH host, and a partially failed spawn no longer leaves live members behind.

### Fixed
- **`pair_start` crashed on hosts without the legacy editor tool names** (win32 included):
  the member deny list filters write candidates against the host tool registry, and a role
  that cannot be stripped of write access now fails loudly — I1 is no longer fail-open.
- **Orphaned members after a partially failed spawn loop**: `retireSpawnedMembers` interrupts
  every already-spawned member before the team directory goes away; `pair_stop` shares it.

### Changed
- **`pair_rotate` is refused in 0.2.x** — member capabilities bind at spawn time, so rotating
  would deny the incoming Driver while the outgoing one kept write access. Dissolve and
  restart instead; the TRADITIONAL pairing note says so.

### Known gaps (tracked, not closed here)
- Rotation needs a dynamic per-role write guard, not a spawn-time deny list.
- The gate never runs a verification command; green-build evidence is honor-system.
- The scheduler has no backoff; a stopped team's id cannot be reused; retired ids and the
  `removed` status are written but never read.

### Tests
- 194 assertions across 8 suites; `npm run verify` is the release chain.

## [0.2.0] - 2026-09-01

The SWE5006 course layer: Agile/XP engineering discipline hardened into the
protocol (PROTOCOL_VERSION 2), plus the user-facing configuration surface.

### Added
- **Test-First Pair Cycles (invariant I7)**: `pair_red` / `pair_green` /
  `pair_refactor` tool steps with `tddMode = enforce | coach | off`
  (default `enforce`); accepted cycles carry failing-test evidence recorded
  before passing implementation, enforced by the gate.
- **User-story tasks with machine-checked INVEST**: `pair_task_create`
  requires role / intent / benefit / acceptance criteria; generic roles
  ("user", "用户"), benefits that merely restate the goal, and missing
  acceptance criteria are rejected with actionable errors.
- **Spike and trivial task kinds**: research work runs a 2-cycle timebox that
  exits with a recorded decision; trivial work skips the ceremony.
- **Structured constructive feedback (invariant I8)**: NO_GO / REJECT must be
  an observation → impact → way-forward triad; REJECT carries a reason
  category feeding retro statistics.
- **Configurable Definition of Done**: gate checklist composed from named DoD
  items (`dod` setting) instead of a fixed list.
- **Green-build rule**: `pair_stop` demands fresh whole-suite evidence when
  changes landed (overridable only with explicit user confirmation).
- **Pairing styles**: `traditional` / `strong` / `ping-pong` via
  `pair_start --style` and `pair_rotate`.
- **`pair_retro`**: session retrospective with keep/try action items persisted
  to `lessons.json` and auto-carried into the next `pair_start` planning.
- **Increment-based progress**: `pair_status` reports accepted working
  increments and completed tasks — never lines of code.
- **Runtime settings namespace `pair-programming`** (dsh-settings): seven hot
  fields layer user overrides (`~/.dsh/settings.yaml` / settings API) over the
  composed profile YAML; provider-less boots behave exactly as composed.
- **Settings → Plugins card** (web UI): hand-written browser client bundle
  (`lib/client.js`, no build step) registered on the `settings.plugin.item`
  slot — staged edits, overridden badges with composed base + reset,
  revision-fenced save, zh/en copy.
- `tests/`: story, settings, and client suites (140 assertions across 6 suites).

### Changed
- `supportedDsh` cohort bumped to `@deepseek-ai/dsh@0.1.2-alpha.3`
  (cordis 4.0.2); SDK peer floors relaxed to registry-satisfiable versions
  with genuinely optional peers (`cordis`, `dsh-settings`) correctly marked.
- Design documentation (DESIGN §12, ACCEPTANCE T11–T14, PROMPT historical
  banner) rewritten to match the self-contained runtime and course layer.
- README restructured as a bilingual promotional + reference document
  (`README.md` / `README.zh.md` / `README.i18n.yaml`).

### Fixed
- `pair_rotate` role swap assigned both members the incoming role's old slot;
  now the outgoing Driver inherits the incoming member's role.
- Raw NUL bytes used as key separators in `scheduler.js` / `members.js` made
  those files binary to git and editors; escaped as `\0` (runtime-identical).

## [0.1.0] - 2026-08-31

Initial protocol layer: Captain/Driver/Navigator/Challenger roles, Pair Cycle
(propose → review → implement → report → verify → risk → gate), hard
invariants I1–I6, three-tier caching, event-driven scheduler, `/pair`
slash command + gesture boundary, degradation ladder.
