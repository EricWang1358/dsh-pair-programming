# dsh-pair-programming

Agile pair programming for DeepSeek Harness. A self-contained plugin that turns a session into the **captain** of a three-agent pair-programming team — **Driver** (the only file writer), **Navigator** (reviewer + quality gate), and **Challenger** (adversarial risk explorer) — with a hard quality gate on every task.

**Zero third-party plugin dependencies.** The plugin ships its own runtime (team state, task dependency graph, JSONL mailboxes, event-driven scheduler) built directly on DSH host primitives (`ctx.subagents`, `ctx.tools`, `ctx.systemPrompt`, `ctx.agents`, `ctx.llm`). It works whether or not `@nanmicoder/dsh-agent-teams` is installed. Mature concurrency/persistence patterns are adapted from that project's MIT-licensed source (per-file credit in `lib/` headers).

## Install & run

**Development (this checkout):** the plugin is a `link:` and loads only in a dedicated dev profile — never the daily `web` profile until it passes every readiness gate:

```sh
node scripts/setup-peers.mjs            # provision @deepseek-ai/* peers resolvable from this dir
node scripts/verify-runtime-imports.mjs # gate ①: every runtime import is a required dep/peer
node scripts/verify-startup.mjs         # gate ②: entry imports + apply() under the real SDK
dsh plugin --profile pair-dev add "$(pwd)"   # local link, loaded only in pair-dev
dsh --profile pair-dev                   # boot the dev profile
```

**Release / daily use (only after `pnpm verify` is fully green = Stable):**

```sh
dsh plugin --profile web add @ericwang1358/dsh-pair-programming   # published tarball
dsh web
```

> Readiness ladder and both automated gates are defined in
> [`docs/06-process/PLUGIN-READINESS-GATES.md`](docs/06-process/PLUGIN-READINESS-GATES.md). A plugin that a
> daily profile auto-loads *is* a release candidate; keep dev work in `pair-dev`.

## Use

```
/pair 实现用户登录接口，要求 JWT + 刷新令牌
/pair 给这个 Express 应用加 /health 端点，带测试 --light
/pair 接入外部支付网关 --tdd=enforce --style=ping-pong
```

or natural language: “用结对编程完成这个需求：……”.

## The protocol (v2 — SWE5006 Agile/XP layer)

Tasks are captured as **user stories** — "As a [specific role], I want [goal], so that [real value]" plus acceptance criteria. `pair_task_create` enforces the machine-checkable INVEST rules (no generic "user" role, no benefit that restates the goal, Testable criteria mandatory); research work becomes a **spike** (tiny timebox that exits with a decision), and obvious trivia runs a short loop instead of the full protocol.

Each small change runs one **Pair Cycle** (Test-First by default):

```
Driver PROPOSE → Navigator GO/NO_GO → Driver RED (failing test first)
  → Driver GREEN (minimal passing code) → Driver REFACTOR (clean under green)
  → Navigator independently verify → ACCEPT/REJECT → Challenger RISK_CHECK (quadrants 3/4)
  → pair_gate_check (configurable Definition of Done)
  → (pass) pair_task_update(completed, gate_pass_id)
```

Session close follows the **green-build rule** — nobody goes home on a red build: a fresh whole-suite evidence line before `pair_stop`, preceded by `pair_retro`, whose keep/try action items the next session's PLANNING automatically inherits (retrospectives, not post-mortems).

Hard invariants (enforced by tooling, not just prompts):

- **Single writer** — only the Driver can edit files; Navigator/Challenger have write tools physically denied via `toolFilter`.
- **Propose before act** — implementation without a Navigator `GO` is void.
- **Test first (I7)** — under `tddMode=enforce`, no production code before a failing test: accepted cycles must carry RED evidence recorded before GREEN (a compile error counts as RED).
- **Completion needs the gate** — `pair_task_update(status=completed)` is rejected without a valid `pair_gate_check` pass against the configured DoD checklist.
- **No risk left overnight** — a P0 blocks the current cycle; a P1 blocks task completion.
- **Evidence over opinion** — every verdict cites repository evidence.
- **Constructive feedback** — a NO_GO/REJECT must be an observation → impact → way_forward triad; vague wishes are rejected by the message schema.

## Modes & styles

- `full` (default): Driver + Navigator + Challenger. `--light`: Driver + Navigator only.
- `tdd_mode`: `enforce` (RED→GREEN→REFACTOR tool-mandated, default) | `coach` (TDD steps available and recommended, plain reports still accepted) | `off` (legacy cycles).
- `style`: `traditional` (stable Driver, rotate on a cadence to raise the truck factor) | `strong` (the idea holder dictates; the Driver is the hands) | `ping-pong` (test author and implementer alternate per cycle).
- Rejections are classified (`invest_violation` / `test_first_violation` / `risk_hit` / `quality`) and surface in `pair_status` and `retro.md` stats.

## State & cache

State lives under `<workspace>/.pair-programming/` (`team.json`, `inbox/*.jsonl`, `cache/`, `retro.md`, `lessons.json`). The L2 evidence cache keys on `sha256(gitHead + subject)` for precise invalidation. Personas are versioned, byte-stable prefixes (per mode/style) to maximize LLM provider prompt-cache hits.

## License

MIT. Contains patterns adapted from `@nanmicoder/dsh-agent-teams` (MIT, © 程序员阿江 / Relakkes).
