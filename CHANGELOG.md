# Changelog

All notable changes to `@ericwang1358/dsh-pair-programming` are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
protocol-level changes are versioned separately in `dsh.sdk.testedCohort` and
`PROTOCOL_VERSION`.

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
