# dsh-pair-programming

**One line of Agile. Zero broken builds shipped.**

> AI agents write code like brilliant lone-wolf hackers: fast, confident, and *alone* — no reviewer, no tester, no one watching your back. `dsh-pair-programming` turns any [DeepSeek Harness](https://github.com/deepseek-ai) session into a **mini agile team** that never lets a line of code through without a review, a test that failed first, and a gate that says DONE.

[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

```
/pair add a JWT login endpoint with refresh tokens
```

That's it. You just became the **Captain** of a pair-programming team — and every change now goes through the same discipline a senior agile engineering org would enforce: *propose → review → test-first → verify → risk-hunt → quality gate.*

---

## Why: the loner-agent problem

Letting a single agent "just implement" your feature is waterfall with extra speed:

- **Nobody reviews until UAT** — defects discovered after release cost up to **100×** what they cost to prevent at the point of creation (and an agent will cheerfully report "done" having tested nothing).
- **Test-after is test-never** — code written without a failing test in front of it drifts from what the user asked for.
- **The bus factor is one** — all knowledge lives in one head (or one context window), and "90% done" means nothing if nothing runs.
- **Fake Agile** — "Sprint 1: requirements, Sprint 5: testing" is waterfall in disguise. Real agile delivers a *verified, working increment* every cycle.

Agile engineering practices — Extreme Programming, pair programming, TDD, user stories, retrospectives — were invented precisely to kill these failure modes in human teams. **They work just as well on agent teams, and agents enforce them more faithfully than tired humans do.**

## What you get: an agile team, not a chatbot

**Solo mode (the default) has two parties, and only one of them is spawned:**

| Role | Who | Duty | Hard rule |
|---|---|---|---|
| **You** | your own session | Frame the work, write the code, run the gate | Cannot accept your own work: the verdict is a re-run of a sealed command |
| **SPEC** | one short-lived subagent | Writes the acceptance test from the request, before any implementation exists, then retires | Holds **no reader, no shell, no search** — only `pair_oracle_write` and `pair_oracle` |

That second row is the whole design. Independence never came from a reviewer having a different *name*; it came from the acceptance standard being written at a *time* when the implementation did not exist and could not be consulted. Because `pair_oracle` runs the test itself, the seat that writes one needs no repository tools at all — so "do not peek at the answer" stops being an instruction the model might forget under a long context and becomes a property of the sandbox it is in.

<details><summary><b>Legacy multi-seat modes</b> (<code>light</code> / <code>full</code>) — still supported, measured expensive</summary>

| Role | Who | Duty | Hard rule |
|---|---|---|---|
| **Captain** | *you*, in your own session | Arbitrate, plan, talk to you | Decides on evidence at the 70% bar, never writes the implementation |
| **Driver** | spawned subagent | The hands: the only agent allowed to modify production/workspace files | No edit without an approved proposal (I1, I3) |
| **Navigator** | spawned subagent | The independent standard: writes the acceptance artifact only in its reserved oracle directory, freezes it from the request *before* any approach exists, then closes cycles with a **computed** verdict | Cannot assert an ACCEPT — the tooling re-runs the frozen oracle (I4, I6, I8) |
| **Challenger** | spawned subagent (`full` mode only) | The red team: attacks the approach with failure modes | A P0 risk blocks the cycle; a P1 blocks task completion (I5) |

Choose these knowingly. Across eight SWE-bench rounds and three live sessions the review seats produced **zero NO_GO and zero REJECT**; one session ran 28 proposals against 0 verifies; and on `pylint-8898` the paired arm returned a **wrong** answer for **1.375×** the tokens of a lone agent, with its declared deliverables never written. 1.375× is the shape of one Driver plus overhead, not of three agents working.

</details>

Eight protocol invariants are enforced **by the tools themselves, not by prompting the models to please you**:

> **I1** single writer · **I2** small steps · **I3** propose before act (small steps auto-GO) · **I4** completion needs the gate · **I5** no risk left overnight — a blocker closes only on an executable artifact, and a P0 in the *acceptance instrument* blocks verification (not implementation) so the tool under repair does not park the work under test · **I6** evidence is a re-run, not a sentence · **I7** test first · **I8** oracle first · **I9** one unverified cycle at a time — new proposals wait for the outstanding verdict

A task literally *cannot* be marked completed without a `pair_gate_check` pass — and the gate **re-runs the frozen oracle itself** rather than reading a claim about it. The resulting credential is bound to that exact oracle and worktree: change either after the pass and completion stops with `GATE_STALE` until the gate is rerun. A vague rejection ("looks off") is rejected by the message schema. Editing the acceptance test you are being judged against changes its digest and becomes an automatic REJECT. Ask the AI nicely and it may forget; the tooling cannot.

**Who can write what.** The Driver alone may modify production/workspace files. Navigator and Challenger are denied generic file editors **and** `pwsh` / `bash` / `Bash`, because a general shell is a write capability. The Navigator can author the independent acceptance test only with `pair_oracle_write`, whose native path guard permits `.pair-oracles/<task_id>/…` and nothing else. The plugin itself runs the frozen oracle and quality gate, so removing the Navigator's shell does not remove computed verification.

### Why an oracle, and not just another reviewer

Eight measured rounds against real SWE-bench issues found **zero correctness separation** between this protocol at v2 and a single agent working alone: same pass/fail sequence, one byte-identical patch, one byte-identical failing render. The reason was structural, not effort — every verification closed over the premise the code was written from. The Navigator reviewed against acceptance criteria the team had authored from its own reading; the RED test was written by the Driver under that same reading; the gate counted evidence strings. Same model, same context, same reading ⇒ correlated errors.

v3 fixes the information problem rather than adding seats. The acceptance standard is derived from the **request alone, before an approach exists**, by a role that has not seen one; it is sealed under a digest; and every verdict after that is a re-execution. The full rationale, with the measurements, is in `dsh-pair-programming-design/01-design/REDESIGN-v3.md`.

### v3.1 — the loop now drives itself

Two full v3 sessions were replayed after the redesign shipped. The mechanisms worked where invoked; what was missing is that nothing made them happen. One session had **151 captain "now do X" prose relays** and **28 proposals against 0 verifies** — the review seat took 2 turns while the Driver took 50, and 35 greens were never verified by anyone. The captain had become the scheduler. Five fixes landed:

- **The board says whose move it is.** Every protocol delivery and `pair_status` carries a derived `[PAIR:NEXT] <who> owes <tool>(<id>) — <why>` line. Turn order is read off the board, not relayed.
- **Back-pressure (I9).** `pair_propose` refuses while an earlier cycle of the same task has no verdict. v3 gated completion on verification but never continuation — that hole is closed.
- **The session phase actually moves.** `PLANNING → CYCLING` on the first proposal; `CYCLING → TASK_GATE` on a gate pass; back on completion. Previously status always read `PLANNING`, even at 3/3 tasks done.
- **No silent oracle bypass.** `type=spike` used to be silently exempt from oracle-first; it now needs either an oracle or an explicit `no_oracle_reason` recorded on the cycle. `trivial` remains exempt outright.
- **Oracle reach.** An oracle that only asserts "does this probe file exist" freezes RED, turns GREEN, and detects nothing about the code. The freeze reports its reach; a `SELF-CONTAINED` verdict is a loud warning carried in status, the digest and the retro.

### v3.2 — the oracle stops recursing

A live 2h 16min session produced **zero accepted increments** because a single oracle was re-forked six-plus times, each fork correct, the set divergent — the protocol had no way to say "good enough for now, ship it as-is with the doubt named". Four fixes:

- **Risk scopes.** `pair_risk` accepts `scope: instrument`. A product P0 halts new cycles as before; an *instrument* P0 halts verification and the gate, not implementation — the measurement being untrustworthy is not a reason to stop producing. Both still block task completion.
- **Non-gating oracle arms.** `pair_oracle` accepts `non_gating_arms[]` with a mandatory `non_gating_reason`. A declared known-red arm prints on every run and routes to its real gate elsewhere, so the oracle can seal instead of being held perpetually behind arms that measure something the task cannot yet fix.
- **Arbitration attribution.** An unnamed ruling used to spend nothing; a captain wrote 18 rulings against a 2/task cap by omitting task ids. The tool now falls back to the claimed task's budget.
- **Freeze budget with escape.** `oracleForkBudget` (default 3) requires `captain_override` past that. Not a wall — friction. Every fork past #1 shows in the summary; recursion becomes impossible to un-see.

## The workflow

### Session level — every story-shaped task earns its increment

```
pair_start ──► PLANNING ──────► CYCLING ◄──── TASK_GATE ──► GREEN BUILD ──► RETRO ──► pair_stop
             user stories +                 (configurable   whole suite    keep/try
             INVEST check   one cycle       Definition      must pass      lessons
             + spike/triage per change      of Done)        before "home")  carried
             70% arbitration                                                    ▼
                                                                    next session's PLANNING
```

### Cycle level — the acceptance standard is written before the code, by something that cannot read the code

```
SPEC seat                          You
─────────                          ───
pair_oracle_write  ──►  authors the acceptance test from the REQUEST only
pair_oracle        ──►  the plugin RUNS it and refuses the freeze unless it
                        FAILS today, then seals the files under sha256
     (seat retires)
                                   pair_propose   declare files[] up front
                                   pair_green     minimal change + report
                                   pair_verify    ← digest recomputed,
                                                    command re-run,
                                                    verdict DERIVED
                                   pair_gate_check replays the oracle,
                                                    checks deliverables,
                                                    checks diff scope
```

You cannot pass your own work: the verdict is whatever re-running the sealed command produces, and editing that command changes its digest into an automatic REJECT. On an ACCEPT you must additionally record `beyond_request` and `preexisting_at_risk` — a re-run proves the *requested* behaviour and is blind to behaviour nobody requested, which is exactly where a measured regression lived (a comma-handling fix silently rewrote an existing list/tuple contract while the oracle and all 18 regression tests stayed green).

**What this costs:** ~1,400 tokens of protocol text and one short-lived seat, against v3's ~3,000 tokens and two-to-three durable seats each replaying a growing transcript.

Every verdict moves as **structured constructive feedback** — *observation → impact → way forward* — the same triad taught to agile teams, here validated by schema. Rejections are auto-classified (`invest_violation` / `test_first_violation` / `risk_hit` / `quality`) and land in the retro stats, because **retrospectives beat post-mortems**: the team improves while the project can still benefit.

Progress is reported in **accepted working increments** — never lines of code, never effort percentages. Working software is the only measure of progress.

## What it looks like in practice

```
/pair 给订单服务加一个退款接口，要求幂等 --light
/pair migrate the payment webhook to the new provider --tdd=enforce --style=ping-pong
```

The Captain drafts stories (*"As a finance ops clerk, I want refund calls to be idempotent, so that double-charges can never hit a customer"* — a generic "As a user" or a benefit that restates the goal is **rejected by the tool** with an actionable error). The Navigator rules on every cycle. The Challenger attacks: *"P0: replayed webhook with the same id refunds twice if the idempotency check is non-atomic — use a conditional update."* Only when every cycle is ACCEPTed, no blocking risks remain, the test-first chain holds, and the DoD passes — *then* the task completes.

**Pairing styles** (real XP, adapted to agents):
- `traditional` — one Driver types, one Navigator watches ahead; the Captain rotates the role so knowledge doesn't pool in one head (raises your **truck factor**).
- `strong` — an idea only enters the computer through the partner's head: the idea holder dictates, the Driver is the hands. The fastest onboarding mode.
- `ping-pong` — test author and implementer alternate ownership per cycle.

**Sizing the ceremony honestly**: research work becomes a **spike** (a 2-cycle timebox whose deliverable is a go/no-go decision, not code); typo-level work gets `trivial=true` and skips the full protocol. Agile knows when *not* to pair — so does this.

## Modes, configuration & cost control

| Config (cordis.patch.yml / profile) | Default | Meaning |
|---|---|---|
| `tddMode` | `enforce` | `enforce` tool-mandated RED→GREEN→REFACTOR · `coach` recommended, both orders accepted · `off` legacy |
| `pairStyle` | `traditional` | `traditional` \| `strong` \| `ping-pong` |
| `dod` | protocol defaults | comma-separated Definition-of-Done items: `all_accepted,no_blocking_risks,verify_evidence,decisions_documented,test_first,oracle_precedes_impl,oracle_replay,spike_outcome` |
| `greenBuildOnStop` | `true` | `pair_stop` demands fresh whole-suite green evidence when changes landed |
| `maxCyclesPerTask` / `spikeMaxCycles` | `12` / `2` | hard budgets — no protocol spinning, no token burn |
| `maxOpenRisks` | `15` | team-wide cap on OPEN non-P0 risk tickets; a P0 raise bypasses it |
| `planningMaxArbitrations` | `2` | disputes resolvable per task while it is still in planning; a task with cycles is exempt |
| `defaultMode` | `solo` | `solo` (you + a short-lived SPEC seat) · `light` (legacy Driver + Navigator) · `full` (adds Challenger) |
| `oracleFirst` | `true` | `pair_propose` refuses a task whose acceptance oracle is not frozen (spikes need `no_oracle_reason` if they skip it; recorded on the cycle) |
| `oracleForkBudget` | `3` | freezes per task before `captain_override` is required — a soft budget that surfaces re-fork loops, never a wall |
| `memberLifetime` | `cycle` | `cycle` respawns each seat from the board digest per Pair Cycle; `session` keeps one durable seat per role |
| `heartbeatMs` | `120000` | liveness sweep for stalled mailboxes; `0` disables. YAML-only — its interval is wired at startup, so it is deliberately absent from the live settings surface |

Protocol overhead is engineered down, not wished away: **event-driven monitoring** (no busy-polling), an **adaptive granularity controller** (3 clean cycles in a row → widen steps; 2 rejections → force smaller), a **3-tier cache** (durable protocol state, L2 repo-evidence cache keyed to `gitHead+path+mtime`, and byte-stable versioned personas that maximize LLM provider prompt-cache hits), and cycle budgets that make spinning impossible. Every token spent is visible in the retro report.

### Runtime overrides without touching YAML (Scrum not everyone's cup of tea)

The hot-tunable fields above are also registered as a host **settings namespace** (`pair-programming`, via `dsh-settings`). Drop an override into `~/.dsh/settings.yaml` — or write it through the settings API — and it takes effect on the next tool call, layered over the profile's composed YAML with reset-back-to-composed semantics:

```yaml
# ~/.dsh/settings.yaml
pair-programming:
  tddMode: coach        # relax: TDD steps available, not mandated
  maxCyclesPerTask: 8   # leaner budget for exploratory work
```

Boots without a settings provider are unaffected (the plugin keeps working exactly as composed). Boot-only fields (`stateDir`, `slashCommand`, member-spawn options) intentionally stay in the profile YAML. The fields above also ship as a **Settings → Plugins card** in the web UI: staged edits, per-field *overridden* badges with the composed value shown and a reset button, save/discard with revision fencing — no YAML required.

## Install

```sh
dsh plugin --profile web add @ericwang1358/dsh-pair-programming
dsh web
```

> Not on npm yet — until the first publish, install from a local path (`dsh plugin --profile web add <path-to-dsh-pair-programming>`), which works identically (restart the app afterwards).

To roll back: `dsh plugin --profile web remove @ericwang1358/dsh-pair-programming` (restart the app afterwards). Local-path installs work identically while developing.

Or develop against a local checkout (`link:` install per [docs](docs/README.md)). Dual activation — the `/pair` slash command *and* a plain-text gesture boundary — covers web UI, headless CLI, and API sessions.

**Graceful degradation, stated up front.** Missing or broken platform capabilities downgrade the session instead of failing it (pure-prompt mode, stateless mode) — and the current mode is declared at the top of every session. 降级优于报错，证据优于意见。

## Verified engineering

```sh
npm test          # 473 assertions across 17 suites, pure-logic, offline
npm run verify    # import gate · startup gate · package gate · typecheck — all green
```

Each fix in v3.1 and v3.2 is pinned by a regression that reproduces the measured failure it prevents: `tests/wake.test.mjs` (the O3 stall), `tests/oracle.test.mjs` (SPEC-FORK / computed verdicts / tamper / reach / bypass), `tests/obligation.test.mjs` (the 28-vs-0 propose/verify asymmetry, phase advance, spike bypass), `tests/scope.test.mjs` (risk scopes, non-gating arms, freeze count visibility), `tests/stall.test.mjs` (the silent permanent stall), `tests/solo.test.mjs` (SPEC isolation is a sandbox property, and the builder cannot pass its own work).

Zero third-party plugin dependencies: the plugin ships its own runtime (team state, task graph, JSONL mailboxes, scheduler) on plain DSH host primitives. Patterns adapted from [`@nanmicoder/dsh-agent-teams`](https://www.npmjs.com/package/@nanmicoder/dsh-agent-teams) (MIT). Full design rationale, invariants and acceptance tests (T1–T14) live in [`docs/`](docs/README.md).

## Why trust this

Every practice here comes from the playbook that made agile work — Kent Beck's XP, the Agile Manifesto's values, Scrum's artifacts and ceremonies — applied where it has never had better conditions than agent teams: agents have *no ego* to defend in a strong-style pair, *no fatigue* in a 30-minute rotation, and *no incentive* to mark a task done without the gate pass. The failure modes of lone-wolf coding don't disappear in AI-assisted development. They get a bigger keyboard.

**Stop code-review theater. Start shipping increments whose acceptance was authored before the code was.**

## License

MIT.
