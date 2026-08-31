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

| Role | Who | Duty | Hard rule |
|---|---|---|---|
| **Captain** | *you*, in your own session | Arbitrate, plan, talk to you | Decides on evidence at the 70% bar, never writes the implementation |
| **Driver** | spawned subagent | The hands: the only agent allowed to touch files | No edit without an approved proposal (I1, I3) |
| **Navigator** | spawned subagent | The eyes: reviews every step, independently re-runs verification | No ACCEPT by parroting the Driver's report (I4, I6) |
| **Challenger** | spawned subagent | The red team: attacks the approach with failure modes | A P0 risk blocks the cycle; a P1 blocks task completion (I5) |

Eight protocol invariants are enforced **by the tools themselves, not by prompting the models to please you**:

> **I1** single writer · **I2** small steps · **I3** propose before act · **I4** completion needs the gate · **I5** no risk left overnight · **I6** evidence over opinion · **I7** test first · **I8** constructive feedback is structured

A task literally *cannot* be marked completed without a `pair_gate_check` pass. A vague rejection ("looks off") is rejected by the message schema. A production-code commit with no failing test recorded before it fails the Definition-of-Done. Ask the AI nicely and it may forget; the tooling cannot.

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

### Cycle level — TDD is not a suggestion, it's the step machine (`tddMode=enforce`, default)

```
Driver [PROPOSE] ──► Navigator [GO] ──► RED      write the failing test FIRST
                                       (a compile error of the missing API counts as RED)
                                       ──► GREEN   minimal code to pass it
                                       ──► REFACTOR clean up under the green safety net
                                       ──► Navigator VERIFY (independently re-runs it all)
                                       ──► Challenger RISK_CHECK ──► GATE
```

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
| `dod` | protocol defaults | comma-separated Definition-of-Done items: `all_accepted,no_blocking_risks,verify_evidence,decisions_documented,test_first,spike_outcome` |
| `greenBuildOnStop` | `true` | `pair_stop` demands fresh whole-suite green evidence when changes landed |
| `maxCyclesPerTask` / `spikeMaxCycles` | `12` / `2` | hard budgets — no protocol spinning, no token burn |
| `defaultMode` | `full` | `full` (3 agents) or `light` (2 agents, fast lane) |

Protocol overhead is engineered down, not wished away: **event-driven monitoring** (no busy-polling), an **adaptive granularity controller** (3 clean cycles in a row → widen steps; 2 rejections → force smaller), a **3-tier cache** (durable protocol state, L2 repo-evidence cache keyed to `gitHead+path+mtime`, and byte-stable versioned personas that maximize LLM provider prompt-cache hits), and cycle budgets that make spinning impossible. Every token spent is visible in the retro report.

### Runtime overrides without touching YAML (Scrum not everyone's cup of tea)

The hot-tunable fields above are also registered as a host **settings namespace** (`pair-programming`, via `dsh-settings`). Drop an override into `~/.dsh/settings.yaml` — or write it through the settings API — and it takes effect on the next tool call, layered over the profile's composed YAML with reset-back-to-composed semantics:

```yaml
# ~/.dsh/settings.yaml
pair-programming:
  tddMode: coach        # relax: TDD steps available, not mandated
  maxCyclesPerTask: 8   # leaner budget for exploratory work
```

Boots without a settings provider are unaffected (the plugin keeps working exactly as composed). Boot-only fields (`stateDir`, `slashCommand`, member-spawn options) intentionally stay in the profile YAML. A dedicated Settings-UI card for this plugin is on the backlog; until then the settings namespace is fully live via the document/API.

## Install

```sh
dsh plugin --profile web add @ericwang1358/dsh-pair-programming
dsh web
```

Or develop against a local checkout (`link:` install per [docs](docs/README.md)). Dual activation — the `/pair` slash command *and* a plain-text gesture boundary — covers web UI, headless CLI, and API sessions.

**Graceful degradation, stated up front.** Missing or broken platform capabilities downgrade the session instead of failing it (pure-prompt mode, stateless mode) — and the current mode is declared at the top of every session. 降级优于报错，证据优于意见。

## Verified engineering

```sh
npm test          # 102 assertions across 4 suites, pure-logic, offline
npm run verify    # import gate · startup gate · package gate · typecheck — all green
```

Zero third-party plugin dependencies: the plugin ships its own runtime (team state, task graph, JSONL mailboxes, scheduler) on plain DSH host primitives. Patterns adapted from [`@nanmicoder/dsh-agent-teams`](https://www.npmjs.com/package/@nanmicoder/dsh-agent-teams) (MIT). Full design rationale, invariants and acceptance tests (T1–T14) live in [`docs/`](docs/README.md).

## Why trust this

Every practice here comes from the playbook that made agile work — Kent Beck's XP, the Agile Manifesto's values, Scrum's artifacts and ceremonies — applied where it has never had better conditions than agent teams: agents have *no ego* to defend in a strong-style pair, *no fatigue* in a 30-minute rotation, and *no incentive* to mark a task done without the gate pass. The failure modes of lone-wolf coding don't disappear in AI-assisted development. They get a bigger keyboard.

**Stop code review theater. Start shipping verified increments.**

## License

MIT.
