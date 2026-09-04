# Changelog

All notable changes to `@ericwang1358/dsh-pair-programming` are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
protocol-level changes are versioned separately in `dsh.sdk.testedCohort` and
`PROTOCOL_VERSION`.

## [Unreleased]

## [0.12.5] — 2026-09-04

### Changed — the settings card is now a top-level settings section

- `lib/client.js` registers on the `settings.section` slot (id
  `pair-programming`) instead of `settings.plugin.item`: **结对编程** gets its
  own entry in the settings sidebar instead of living inside
  插件 → 插件配置. The card component, staged-edit form and revision fencing
  are unchanged; the section supplies its own locale binder (`t`) because the
  section shell passes only `close`.
- This intentionally supersedes the 0.12.4 pin "the settings slot name —
  `settings.plugin.item` matches the shell": that described the shell this
  release replaces.

### Added — a captain key-moment table for the armed CE lane

- With a pair lane on (`advisory`/`full`), the system-prompt prefix now names
  the four moments where the captain — the seat with the widest board view —
  is expected to load an analytical CE skill: **ce-proof** against the
  evidence chain before every `pair_gate_check` pass, **ce-pov** before a
  `pair_arbitrate` ruling that picks between two live readings, **ce-debug**
  before closing a P0/P1 risk ticket and after a second stalled round on the
  same seat, and **ce-code-review** over the finished diff surface at
  `pair_retro`. Routine GO/step traffic never justifies a load — the cadence
  is pinned in the prefix, not left to taste.
- Lane `off` renders nothing (byte-identical prefix); lane `captain` renders
  no table either, because gesture-served skills cannot be self-loaded by a
  seat. Every load is still recorded on the board, so cadence is auditable.

### Fixed — the member wake called an API the host never had

- `deliverToMember` called `ctx.subagents.followup(captain, childId, …)`. The
  service has **no `followup`** — it lives on Agent *handles* only — so the
  plugin's auto-wake leg was a phantom and **never once succeeded**: the
  surrounding try/catch swallowed the TypeError into
  `{ ok: false, "the host refused the wake" }`, every mailbox delivery
  starved into the 120s heartbeat sweep, handoffs degraded to sweep-cadence
  (one member working at a time, everyone idle in between), and recovery ran
  through the captain relaying `send_message` by hand. Five live-session
  STALL reports could not say why; this is why — and part of the 151-captain-
  relay / zero-`pair_verify` ledger in `obligation.js` was this bug, not the
  protocol.
- `deliverToMember` now calls `ctx.subagents.sendMessage(sender, targetId,
  content, { signal })` — model-authored mail between adjacent Agents. Chosen
  over the `prompt` control face deliberately: `prompt` records **one human
  message**, so protocol mail would impersonate the user in the child's
  session history, and it refuses an absent child (`subagent/not-resumable`)
  where `sendMessage` documents the **cold resume** the scheduler's recovery
  path needs. The returned inbox `MessageId` surfaces in the ok result, so a
  wake that landed is distinguishable from one that did not. Seven test
  fixtures migrated off the phantom shape; new assertions pin the adjacency
  contract (exact live captain Agent as sender, member session id as target,
  single text ContentBlock, caller signal passed through).
- New static guard in `host-contract.test.mjs`: every `ctx.subagents.<method>`
  literal call in `lib/` is asserted to exist in the host package's declared
  surface — the whole phantom-API family, not just this one, is now machine-
  checked. Literal-scan limitation (aliases) stated in the guard's comment.
- Effect: handoff latency returns from "up to one sweep + captain relay" to
  event-driven; the designed pre-work overlap (navigator pre-reads while the
  driver writes, challenger pre-arms) works again without captain relay.

## [0.12.4] — 2026-09-04

### The audit behind 0.12.3: why 893 tests missed a four-release outage

Not one test, and not `scripts/verify-startup.mjs` either, had ever mounted a
real host service. Every suite handed `apply()` a hand-written object per
service, and a stub agrees with the code that wrote it by construction: it can
check that we call `register`, never that what we pass is something the host
would accept. Three host contracts were audited by mounting the real
registries; two held, one was already broken (0.12.3), and one turned out to be
a documentation landmine.

### Added — tests that go through the host

- **`host-contract.test.mjs`** mounts the real `ToolRuntime`, `SystemPromptService`,
  `CommandRuntime` and `SkillRegistry` on a real Cordis context and runs the
  real `apply()`. It pins all 22 tool schemas as the registry accepts them, the
  `/pair` descriptor including `input.images`, the prompt section, and that a
  catalog fetch never throws and every candidate carries a string `provider`.
- **`events.test.mjs`** pins the session-event guard and, more importantly, the
  harness facts that make it correct.

### Fixed — a comment that invited a catastrophic change

`lib/events.js` claimed the plugin's events let "the web client fold a protocol
timeline from the session log". They cannot, and the guard that drops all six
`pair/*` types is load-bearing rather than a defect:

- `Session.append()` does not check the type and would write ours happily;
- `KNOWN_SESSION_EVENT_TYPES` is a READ-path set whose own header says
  downstream plugin events are outside it **by construction**;
- `dsh-session-persistence.assertEventsSupported` then **throws
  `SessionFormatUnsupportedError`** on any persisted event outside that set,
  refusing to interpret the entire log;
- `ignorable` is the designed escape hatch and `append()` offers no way to set it.

So "fixing" the guard to make events appear would trade a UI panel nobody has
for sessions that cannot be resumed. The comment now says that, and the test
fails if a future harness changes it — making the change deliberate.

### Audited and sound

- **Tool schemas** — all 22 accepted by the real `ToolRuntime`.
- **Settings** — both namespaces register on the real file-backed provider;
  schema, base layer and validation round-trip. Cross-checked that no schema
  field is missing from `settingsEntry` or `toRuntimeSettings`, which would
  silently ignore a composed YAML value.
- **The command descriptor** — accepted by the real `CommandRuntime`.
- **The settings slot name** — `settings.plugin.item` matches the shell.

### Still unverified by tests, stated rather than implied

`llm`, `agents` and `subagents` have no standalone mount (they need a live
model, a session store and a child-agent driver), so `startContinuable`'s
request shape and the browser card's contract with the real web shell remain
covered only by live runs.

## [0.12.3] — 2026-09-04

### Fixed — the CE catalog was dead in a live session

A real run failed with:

    skill provider "pair-ce" returned skill "ce-code-review" with a non-string provider

`dsh-skill` validates every listed candidate and requires `provider` to be a
string equal to the registering provider's own name. Our `list()` never set it,
so the FIRST catalog fetch in a live session threw and no CE skill was ever
served — from V5.3b (0.8.0) until a user hit it.

- Candidates now carry `provider: CE_PROVIDER_NAME`.
- **New `ce-registry.test.mjs` drives the real `SkillRegistry` on a real Cordis
  context**, because that is the only thing that checks: 45 assertions across
  the CE suites called `makeCeProvider(...)` directly and inspected the object
  we returned, which is exactly the shape of test that cannot see a host
  contract violation. It asserts the accepted catalog, the invocation split
  through the host's own predicates, the loaded body with its boundary, the
  solo lane, and disposal — and pins the broken shape as a regression with the
  registry's own error text.

This is the second dead composition under green unit tests in this integration
(the persona push was the first, fixed in 0.12.1). The rule now recorded in the
design notes: **when a contract belongs to the host, test through the host.**

## [0.12.2] — 2026-09-04

### Fixed — `/pair` refused image attachments

Submitting `/pair` with a screenshot was rejected by the composer with "/pair
does not accept image attachments". The message comes from the host
(`dsh-client-ui-commands`), but this plugin caused it: a command admits images
only by declaring `input.images: true`, and `/pair` declared only a hint. The
gate is enforced twice — the composer refuses before dispatch, and the registry
refuses again at execution — so the goal never reached the handler.

That closed the front door on precisely the work this protocol was hardened on.
The retrospective quoted throughout this codebase is a visual project that
shipped rain as white squares and puddles with no reflections; a goal about how
something LOOKS has to be able to show it.

- `/pair` now declares `input.images: true` and forwards
  `invocation.attachments` into the activation follow-up, text first so the
  gesture boundary still matches on the activation line.
- A goal with images but no text stays a usage error, and says the images are
  retained — returning an error is what makes the composer keep the originals,
  so a refused submission never costs the user their screenshots.
- New `command.test.mjs` pins the declaration, the ordering, the retention on
  refusal, and that the no-attachment path is unchanged.

## [0.12.1] — 2026-09-04

### Fixed — the persona push was unreachable, and its contract comment was false

An external review found the flagship push path dead in the default
configuration. It was worse than reported: three independent reasons, each
invisible to a unit test on the function itself.

- **The loader did not state its lane.** `ce.load` called the provider with no
  `cwd`, the resolver read that as "no team live", and the solo lane answered —
  which at the shipped default (`ceSoloLane: off`) serves nothing, so the push
  silently produced an empty appendix. With a solo lane on it was worse: it
  would have pushed a body with NO ownership boundary into a live team's seat,
  the exact misread the boundary exists to prevent. The loader now states
  `teamLive: true`, which is a fact about a respawn rather than something to
  infer, and the provider honours an explicit override.
- **The trigger named a step that cannot exist.** `cycleStep === 'REFACTOR'`
  never matches under `oracleFirst` (the default), because an oracle cycle
  folds REFACTOR into GREEN and `pair_refactor` refuses a separate round.
- **And no step is current at a respawn anyway.** A seat is recycled only after
  a cycle was ACCEPTED, so the last cycle always carries a verdict and
  `currentStepOf` returns `undefined` at exactly the moment the persona is
  composed. The trigger is now a board phase — `post-green`: the live task has
  an accepted cycle and is still open — which is reachable, and is the same
  intent ("advice about shape, once behaviour holds").
- **An integration test now covers the assembly**, not the pieces: the real
  loader wiring, a live team, and an assertion that the pushed body carries the
  boundary and lands in the ledger as `teamLive: true`. The dead shape is
  pinned as a regression.

### Fixed — other review findings

- **`get()` reads the lane through the cache.** A team going live inside the
  5s resolver TTL could otherwise be served a solo body; that is the one
  staleness that matters, since the body is what carries the boundary.
- **The write-lane refusal now names a way out.** It states the false-positive
  edge (attribution is workspace-and-window, so an unrelated load in the same
  workspace lands there too), lists three executable exits, and says plainly
  that there is no exemption flag, so nobody hunts for one.

### Verified, not changed

- **`modelInvocable: false` is enforced, not merely declared.** The review
  flagged it as an unverified claim. `dsh-tool-skill` filters the catalog with
  `isModelInvocable` and refuses a `skill` call with it twice (on the summary
  and again after load). A test now pins our invocation objects against the
  host's own predicates from `@deepseek-ai/dsh-skill`.

### Known limitations, now written down

- **Semantic drift is not guarded.** The closed allowlist stops a CE upgrade
  from adding skills, and a changed version or count raises `reviewNeeded`, but
  an existing skill whose body changes meaning under the same name is served
  verbatim behind a routing line we authored. The fingerprint records the
  commit; the provider serves whatever the checkout currently holds.
- **Attribution is workspace-scoped.** With one workspace and several
  concurrent tasks, a legitimate write-lane load can refuse an unrelated card's
  credential. Deliberate: the gate errs toward refusing.

## [0.12.0] — 2026-09-04

### V5.5 — two CE lanes, chosen by whether a pair team is live

Standalone CE and CE-inside-the-protocol are different tools with different
risks, and until now one setting had to serve both. With no team running there
is no single-writer invariant to protect and no completion receipt to keep
fresh, so `ce-work` and the shipping family are exactly what CE is for. The
moment a team goes live those same skills would put a second execution loop
behind the same worktree. So the lane is no longer a knob anyone has to
remember to flip — it follows the board.

- **`ceSoloLane`** (`off` | `gesture` | `curated` | `full`) governs a session
  with no live pair team; **`ceLanes`** governs one with a team. The provider
  resolves which applies per workspace on every catalog fetch, cached for a few
  seconds, and an unreadable state directory errs narrow (assume a team is live)
  rather than widening the lane.
- **Measured cost of each lane** — `gesture` 0 tokens/step (every skill, human
  `/name` only), `curated` ~160, `full` ~744 for all 33. CE's own frontmatter
  for the same 33 is 7,487 characters (~1,870/step), so the authored routing
  lines cut the widest lane to roughly 40% of forwarding them.
- **The ownership preamble is pair-mode only.** Prefixing "the pair protocol
  owns every write" onto a skill running in a session with no protocol would be
  a claim the model then has to reconcile against a workspace where it is false.
- **The catalog is one table** of all 33 rows with their lane placement, so the
  three-way partition and the two lanes cannot drift apart, and the allowlist
  digest covers every row.

## [0.11.1] — 2026-09-04

### Fixed

- **The write-lane refusal could not actually fire.** V5.3d's gate check read a
  ledger written only by this plugin's own `provider.get()`, and this plugin
  never serves a write-lane skill — so the refusal was unreachable on exactly
  the configuration it was written for: a CE checkout wired into an ordinary
  skill root (`~/.agents/skills`, `~/.dsh/skills`, `customSkillDirs`), where
  every load is served by `dsh-skill-filesystem` instead. The rule was right;
  the observation was in the wrong place.
- **Loads are now observed at the tool pipeline.** Every skill load from every
  provider is a `skill` tool call, so a `tools/pre-execute` listener — the same
  hook the board write guard uses, for the same reason — records CE loads into
  the ledger regardless of who served the body. It is installed unconditionally
  (including with `ceLanes: off`, since a user can wire CE into a skill root
  without telling this plugin anything), costs one string compare per tool
  call, and never denies a call: loading a skill is not the violation, issuing
  a completion credential afterwards is.

## [0.11.0] — 2026-09-04

### V5.4 — a retro entry earns its place in the long-lived store

The failure this closes is not a missing retrospective. It is one that works:
every session produces keep/try items, every one is carried into the next
session's planning and into the board digest every recycled seat reads, and
nothing ever removes one. The store grows monotonically while each individual
entry looked reasonable on the day it was written.

- **Two destinations, not one.** `retro.md` takes everything and costs nothing
  later. The cross-session store is a prompt input, so an entry reaches it only
  as an object answering the counterfactual: `{lesson, counterfactual,
  reuse_trigger, evidence[]}`, and `rederivable_from` disqualifies anything the
  repository already says. A bare string is archived rather than carried, and
  the tool reports what it archived and why — nothing a captain wrote is lost.
- **A cap that forces ranking.** At most `maxCarriedLessons` (default 3)
  entries are carried; a retro that proposes more admissible entries is refused
  with the candidates listed, because which ones matter is a judgement the
  captain has to make and a silent truncation would make it invisibly.
- **The answers travel with the entry,** so a later session can judge whether a
  carried lesson still holds instead of inheriting an unattributed assertion.
  The board digest renders structured entries as their text.

## [0.10.0] — 2026-09-04

### V5.3d — every load is on the record, and a second loop refuses the credential

- **The load ledger.** Every CE body this plugin serves is appended to
  `<stateDir>/ce-loads.jsonl`. `get()` is our code, which is the whole reason
  to own the provider; a failed audit line never breaks a working skill.
- **The gate reads it.** `pair_gate_check` inspects the window from the task's
  earliest cycle: if a skill that owns an execution loop or a shipping action
  (`ce-work`, `lfg`, the commit/PR/worktree family) was loaded in that window,
  no gate credential is issued — a credential binds a claim to a worktree, and
  a second scheduler behind that worktree makes the binding describe a state
  nobody owned. `pair_stop` applies the same rule to the completion receipt
  over the team's whole window.
- **Two honesty rules in that check.** This plugin never serves those skills,
  so a hit always means another skill root, and the refusal says so. And an
  unreadable ledger fails: "we could not look" must never resolve the same way
  as "nothing happened". A deployment that never wired a ledger is unaffected.
- **Attribution is stated, not implied.** `get()` receives a cwd and no caller
  identity, so a load is attributed to a workspace and a time window rather
  than to a seat, and the refusal text says exactly that.
- **The one push case.** Lane `full` hands the Driver `ce-simplify-code` in its
  persona at respawn, and only while the open cycle is at REFACTOR. It loads
  through the same provider — same allowlist check, same boundary preamble,
  same ledger entry — is capped at 2,400 characters with the cut declared, and
  is cached per CE commit so a per-cycle respawn does not re-read it. A failing
  or missing body pushes nothing rather than half a persona.

## [0.9.0] — 2026-09-04

### V5.3c — the advisory catalog, with its price on the label

- **`pair_status` names the lane.** The active CE lane, the size of the model
  catalog it publishes, the detection it serves from, and the advisory boundary
  are one board line — because a lane changes what a seat can load mid-cycle,
  and that is protocol state a captain must read without leaving the tools.
- **Cost is reported, not assumed.** `catalogCost(lane)` measures what a lane
  adds to the per-step catalog; the Settings card shows it beside the lane
  selector, and the derived namespace carries it. Lane `advisory` publishes 7
  skills for ~140 repeated tokens per step, against the 4,571 characters CE's
  own frontmatter would cost for the same set. This is the number the
  integration's measurement gate is meant to be argued with.
- **The system prompt gains a CE paragraph only when a lane is on.** With
  `ceLanes: off` the section is byte-identical to a build without the
  integration, so nobody pays a prefix for a feature they never enabled.
- **A lane switch republishes the price without re-reading the disk** — nothing
  on disk changed, so a re-probe would be theatre.

## [0.8.0] — 2026-09-04

### V5.3b — the CE skill provider, and the user/model surface split

- **This plugin owns the provider** (`ctx.skills.registerProvider`) instead of
  pointing `dsh-skill-filesystem` at CE's `skills/`. That buys the closed
  allowlist, a rank (700) that can never shadow a local skill of the same name,
  descriptions we author, and one observation point: `get()` is our code.
- **The surface split is the token story.** The five constructive skills
  (`ce-brainstorm`, `ce-ideate`, `ce-strategy`, `ce-plan`, `ce-compound`) are
  served with `modelInvocable: false` — they never enter a model catalog and
  cost zero repeated tokens, reachable only when a human types `/<name>`. The
  seven analytical skills enter the catalog for 532 characters of authored
  routing lines, against 4,571 characters for CE's own frontmatter.
- **Every served body carries the ownership boundary first:** the pair protocol
  owns all writes to product code, the skill's own execute/commit/PR steps are
  not to be run here, findings return through the pair tools, and the frozen
  oracle is sealed. CE's own text then follows verbatim, with its frontmatter
  stripped.
- **The provider is registered once and reports an empty catalog** when the
  lane is `off` or no checkout was detected. `dsh-tool-skill` sends no catalog
  tokens for an empty list, so an idle integration costs nothing, while a
  provider that appeared and disappeared would append a full replacement
  catalog to every live session on each toggle.
- **Known limit, stated rather than papered over:** `SkillProvider.list/get`
  receive no caller identity and the registry's scope layers belong to
  agent-preset compositions, not to members spawned through `startContinuable`.
  Per-role filtering is therefore impossible in the provider; it lives in the
  member `toolFilter` and in the gate that reads the load record (V5.3d).

## [0.7.0] — 2026-09-04

### V5.3a — read-only Compound Engineering detection

- **Detect button in the Settings card.** The card is browser code with three
  services and no filesystem, so the button cannot detect anything itself: it
  writes `ceProbeToken`, the host observes that committed change, probes the
  filesystem read-only, and publishes the result into a second, host-owned
  namespace (`pair-programming-ce`) the card renders. Settings as a one-shot
  RPC; a typert Remote is the documented upgrade path, not a V5.3 dependency.
- **Detection is read-only, always.** Candidate roots are an explicit `cePath`,
  `~/.dsh/packages/compound-engineering-plugin`, and the Claude Code v2
  registry's `installPath`. Identity is CE's own manifest plus a non-empty
  `skills/`; the commit is resolved by reading `.git` (ref, detached, or
  `packed-refs`) rather than spawning git. Nothing is downloaded, cloned, or
  written into a skill root — installing CE stays the user's own action.
- **A fingerprint, not a boolean.** `path + version + commit + skill count +
  our own allowlist digest` identifies a detection, so a CE upgrade *or* an
  edit to our allowlist invalidates a recorded link, exactly as a gate
  credential is invalidated by a moved board or worktree.
- **The allowlist (`lib/integrations/ce-catalog.js`) is closed** and accounts
  for the whole reviewed release: 12 exposed, 9 refused as write-lane/shipping
  (`ce-work`, `lfg`, the commit/PR/worktree family), 12 reviewed-but-deferred.
  A CE upgrade that adds a skill exposes nothing until a human adds a row, and
  a changed skill count raises `reviewNeeded` on the card. Descriptions are
  authored here rather than forwarded: a model catalog costs repeated input
  tokens on every step, and CE's own frontmatter for these skills runs 4,571
  characters.
- **`ceLanes` defaults to `off`,** which registers no provider at all — a
  deployment without CE, or one that does not want it, pays exactly zero
  tokens. `captain` exposes only the user-gesture surface, which is still zero
  model-facing tokens.

## [0.6.0] — 2026-09-04

### V5.2 — a ruling says what happened to the gap, and where the residual lives

- **`disposition` is required** on any `pair_arbitrate(closes_disclosure=...)`:
  `fixed` (the gap is gone and the evidence shows it), `accepted` (it ships
  as-is, knowingly), or `deferred` (postponed to named later work).
- **A residual must have a durable home.** `accepted` and `deferred` also
  require `sink` (`board | issue | document | pr`) and a traceable `sink_ref`.
  The measured failure this closes is a real ruling — "accept visual arm as
  backlog" on a board that had no backlog: it read as settled, the disclosure
  left the open list, and the residual survived only in a session transcript.
  `fixed` needs no sink; its evidence is the record.
- **Residual ledger.** `pair_status` renders `Residual ledger:` and returns
  `residual_ledger`; the `completion_receipt` carries every non-`fixed`
  residual with its sink, so a receipt can be audited against a board that
  legitimately accepted or deferred something.
- **Legacy rulings stay visible without being retroactively fatal.** A pre-V5.2
  decision that closed a gap with no disposition appears in the attention set
  as `unsunk-residual` and never blocks completion — the enforcement point is
  the tool, and no ruling written from here on can reach that state.

## [0.5.0] — 2026-09-04

### V5.1 — one attention set, and a bounded resume after a token cut-off

- **Attention Set (`lib/protocol/attention.js`).** One projection recomputed
  from the board at every wake, replacing three independent readers of the same
  state: blocking P0/P1 risks, gate credentials that stopped binding, seats cut
  off at the token ceiling, the owed protocol call, and every unruled
  disclosure — ordered by urgency. `pair_status` prints it, its structured
  result carries `attention_set`, the board digest carries the top five, and the
  stall escalation carries it verbatim, so a captain can no longer be told one
  thing and refused at `pair_stop` for a reason nothing had shown.
- **Bounded resume after `max-tokens`.** A turn truncated at the output-token
  ceiling ends *normally*: the seat goes idle, the board never moved, and the
  nudge dedupe (keyed on an unchanged debt) suppressed the one message that
  would have restarted it. The scheduler now recognises the cut-off, continues
  the seat from the current board state at most `maxTokenResumes` times (default
  2) for the same owed call on the same board revision, and then parks it as a
  captain ruling. A board that actually moved refunds the budget; long
  truncated prose does not, because only a board mutation changes `updatedAt`.
- **`maxTokenResumes`** joins `heartbeatMs`/`workingLeaseMs` as YAML-only
  liveness tuning; `0` escalates on the first truncation.

### Protocol v5 — disclosed gaps have an owner

Built from a measured visual-project retrospective: 9/9 cards and 132/132
structural assertions passed while rain still rendered as squares, puddle
reflections were unreadable, and only the initial camera had been inspected.
The gaps had been disclosed, but the protocol did not turn disclosure into work.

### Added
- **Amendable planning cards.** `pair_task_amend` can replace story fields,
  acceptance allocation, deliverables, dependencies, subject, and description
  before the first cycle. It records a revision trail and atomically revokes a
  live attempt. Acceptance-changing edits invalidate a frozen oracle;
  scheduling and deliverable-only changes preserve it.
- **Staged computed verification.** `pair_verify(stage="checkpoint")` settles a
  deliberately partial cycle by executing the proposal's predeclared
  `verify_plan`. It never claims final acceptance. `stage="final"` still runs
  the complete sealed oracle, and the gate requires at least one final ACCEPT.
- **Disclosure obligations.** Non-gating oracle arms, oracle-directed tuning,
  deviations from the approved proposal, beyond-request behaviour, and explicit
  oracle bypasses now appear in `pair_status.open_disclosures` and the board
  digest. The next-obligation engine assigns them to the captain, and successful
  stop is blocked until each ref is closed by an auditable
  `pair_arbitrate(closes_disclosure=...)` ruling.
- **Planning and control-plane regressions.** New suites cover task amendment,
  disclosure ownership/closure, staged verification, idempotent gate replay,
  credential staleness, and completion-time board binding.

### Fixed
- **Gate credential identity and binding.** Replaying an unchanged gate reuses
  the same `gate_pass_id`. A pass is bound to the task contract, cycles, task
  decisions, P0/P1 risk state, oracle, worktree, and executed gate command.
  Material post-gate changes produce `GATE_STALE`; a legitimate transition to
  `completed` does not stale its own credential. Successful stop rechecks every
  credential against the final board and worktree. The task carries the id as
  soon as the gate passes instead of relying on a later seat report.
- **Status board drift.** The versioned structured result always exposes
  `cycles`, the complete durable `risks` register, and canonical `coverage`;
  `goal_coverage` remains as an equal compatibility alias and `open_risks` as
  the filtered view. `gate_credentials` names the latest pass, the id bound to
  each task, and whether the board-state binding is current.
- **Acceptance criteria disappeared from the board digest.** The digest read a
  nonexistent top-level `acceptanceCriteria` property. It now reads the stored
  `story.acceptance_criteria` contract.

### Changed
- **Granularity only tightens automatically.** Two rejections still force a
  smaller next cycle. A clean streak no longer widens implementation scope;
  that suggestion contradicted the small-step invariant in the session that
  exposed it.
- **I1 now names its complete workspace boundary.** Tooling, provisioning,
  vendor, probe, and scratch files inside the workspace follow the same
  single-writer rule as production files. There is no role-dependent setup-file
  exception.

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
