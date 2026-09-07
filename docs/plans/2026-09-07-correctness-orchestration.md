# Correctness-first orchestration

Date: 2026-09-07. Execution: code. Authority: user explicitly permits substantial refactoring and prioritizes correctness over latency.

## Goal

Make review evidence and task ownership reliable under delayed, duplicated and concurrent events. Preserve the canonical workspace's single Driver. Research and benchmark design are owned by the parent research task; implementation uses ce-work return-to-caller with native execution.

## Starting state and scope

HEAD bc154a8c8465077102bf42ba7233e9fd0f2a79af, branch fix/stability-recovery. Existing unrelated edits in CHANGELOG.md, README.md, README.zh.md, package.json and scripts/setup-peers.mjs are excluded. No release, dependency upgrade or restart of the user's running host belongs to this change. Existing recovery repairs and M11 session-event guard remain intact. User steering requires actual DSH acceptance using OpenCode Go / muse-spark-1.3-contributor (configured provider opencode-go-muse). Bounded native smoke runs are authorized; the larger comparative quality benchmark remains a separate experiment.

## U1. Derive task obligations and stable continuation budgets

Files: lib/protocol/obligation.js, lib/protocol/attention.js, tests/obligation.test.mjs, tests/attention.test.mjs. No other production files in this unit.

Expose a deterministic obligation frontier rather than inspecting only the last global cycle. Keep nextObligation as the compatible primary projection and add recipient selection. Process live tasks and their latest cycles; pending tasks must have satisfied dependencies. Terminal tasks and superseded cycles do not create work. A REJECT rewinds the existing cycle and remains outstanding; terminal accept/checkpoint closes it. A latest checkpoint or reject must not be hidden by an earlier ACCEPT. Distinguish driver work from Navigator review. Support solo captain/spec ownership without inventing absent seats. A reviewer may prepare an oracle for a dependency-ready future task while the Driver implements the current one, but never perform two concurrent canonical code writes. Oracle-free/trivial task handling must agree with the existing tool exemptions.

Continuation budgets and dedupe keys bind to the owed task/cycle/attempt and relevant protocol state, not team.updatedAt (heartbeat/activity/resume writes are not progress). Attention shows all owed work and exhaustion per seat. Keep keys compact and deterministic. A repeated rejected cycle's next action must be actionable under existing tool APIs; document any interface gap for U3.

Evidence: strengthen existing tests first and observe failures. Cover two live tasks, newer completed cycle hiding old debt, blocked dependencies, reject/checkpoint after acceptance, terminal teams, solo, metadata-only writes, changed attempt, meaningful cycle progress. Focused tests may use temp directories; no shared builds or Git writes by workers.

## U2. Bound delivery and integrate independent seats

Depends on U1. Files: lib/runtime/scheduler.js, lib/tools/shared.js, lib/runtime/collapse.js, lib/state/mailbox.js, lib/protocol/messages.js as needed; existing wake/collapse/state suites, with dedicated delivery tests if separation improves clarity.

Limit each fallback delivery by message count and UTF-8 bytes. Select and lease under the team lock; ACK only selected messages accepted by the host, release only that delivery's leases on failure. Preserve all unread control messages and remaining backlog; oversized records become explicit read-by-id references rather than silent truncation or an unlimited prompt. Prioritize stop/correction/control traffic without starving ordinary mail. Attach CURRENT task obligations at delivery; stored NEXT prose must not override fresh state. Avoid pushing unbounded routine messages into a running host inbox; retain durable receipts for its next idle edge. Keep direct critical control notification possible. Never remove unknown session-event protection.

Kick independent seats concurrently with per-seat serialization and failure isolation; no mutation outside the existing team locks, no unbounded loops. Non-Driver seats must not silently claim shared implementation tasks. Preserve existing explicitly assigned research work where the task API permits it. Report bounded delivery/backlog in diagnostics.

Evidence: real temporary JSONL + mock host boundary; burst over batch limit, multibyte messages, control behind routine mail, oversized record recoverability, duplicate kicks, failed/cancelled/reclaimed leases, fresh board after queued old notice, one hung seat does not prevent another from entering delivery. No busy waits or uncapped model calls.

## U3. Review has veto authority and a stable evidence boundary

Depends on U1 and U2 integration (shared flow and delivery contracts). Files: lib/tools/flow.js, a focused verification helper if warranted, lib/tools/oracle-exec.js, lib/protocol/gate.js or related consumer only if needed; tests/oracle.test.mjs, tests/scope.test.mjs and focused regression coverage.

An explicit, structured reviewer REJECT must never become ACCEPT just because a narrow oracle is green. Validate verdict inputs before running commands. Bind asynchronous verification to the task attempt, cycle, sealed oracle and candidate workspace before/after execution, and revalidate inside the commit lock. A changed task/cycle or candidate refuses the stale call without charging a false code rejection. Infrastructure execution failure is not a product verdict. Prevent duplicate completed verdicts from rewriting history. Preserve legacy no-oracle contracts and solo restrictions. Continue to require the final task gate; no claim that generated tests prove all correctness.

Evidence: existing green-oracle path; green oracle plus an independently reproduced counterexample; malformed veto; task reassignment/cycle advance while command waits; command editing candidate/oracle; duplicate concurrent verification; post-reject repair. Run real short Node commands against temp fixtures, not a fake return substituted for the verdict logic. Reuse existing workspace fingerprint and repair any proven hash collision needed for this boundary (e.g. HEAD change with clean diffs).

## U2b. Collapse board-absorbed receipt backlog

Depends on the U2 delivery contract; execute after U3 to keep the shared write lane serial. Scope: lib/runtime/collapse.js, lib/runtime/mail-delivery.js and focused collapse/delivery tests. A measured synthetic U2 probe with 1,000 already-absorbed GREEN receipts still needed 125 notifications (121,500 total bytes, 973 maximum). A byte limit alone does not prevent empty model turns.

Use the existing conservative board-absorption predicate to represent absorbed receipts in one bounded summary. Lease and conditionally ACK every receipt covered by that accepted notification, keeping original durable content. Count the summary against the logical notification limit, keep unabsorbed and control messages individually bounded, and preserve fair ordinary admission. Never collapse REJECT, NO_GO, P0/P1, unknown messages or facts not present on the current board. State clearly in diagnostics how many physical records the summary covers. Test the burst shrinking to a single notification, mixed urgent mail surviving verbatim, and failed/reclaimed delivery retaining all original records.

Independent fault review reproduced two further U2 defects. A delayed retired member's admission occupies a logical-seat flight and blocks its replacement; late completion must never clear the replacement's flight. Urgent suppression also leaks across idle/running edges when the previous admission settles after a new turn begins. Extend this unit to scheduler.js, shared.js and mail-delivery.js: use member identity for delivery generations and synchronously observe turn edges, then conditionally mark only the captured turn. Cover members and captain with deterministic delayed host acceptance tests. Preserve claim-token ACK semantics and bounded maps.

Keep parallel oracle preparation outside the current candidate's verification window. Extend obligation.js and oracle.js with one shared rule: future-task drafts may proceed while the canonical task is being prepared/implemented, but pause once its candidate reaches GREEN/report/review/gate. Enforce the write under the team lock as well as in the obligation frontier, so an in-flight draft finishes before a GREEN transition can be recorded. Never solve the conflict by excluding potential oracle dependencies from the candidate digest. Test draft overlap, pause after GREEN, and resumption after terminal current work.

## U3 follow-up. Recover checkpoint ancestry without weakening final review

Depends on U2b write release. Independent review reproduced two regressions in committed U3: an earlier checkpoint's old oracle seal and openedAt prevent a later defect re-freeze from ever reaching a gate; successful test output containing "No such file or directory" is incorrectly classified as infrastructure failure despite exit 0.

Files: lib/protocol/gate.js, lib/tools/arbitrate.js, lib/tools/oracle.js, lib/tools/verification-boundary.js, tests/verification.test.mjs. Record explicitly audited checkpoint supersession during legitimate oracle replacement. Exempt matching historical checkpoints from the current-oracle seal/time checks while retaining their scope and Test First evidence; they cannot replace the latest current final ACCEPT. Missing/modified audit must not grant an exemption. Apply command-not-found output heuristics to failed commands only after cancellation and normal-exit checks.

Evidence: public tool sequence checkpoint -> later REJECT -> defect re-freeze -> repair -> current final ACCEPT -> gate; preserve old verification, require final acceptance, reject absent supersession audit and missing historical RED. Passing checkpoint/final commands may print expected missing-file diagnostics. Existing cancellation, missing-command and stale-attempt tests remain required.

## Verification contract and done

Observe regression failures before implementation, then focused green tests. Parent runs npm run verify on the integrated tree and records actual counts, type/import/package/startup checks. Inspect real diff for unintended edits and run independent review. Deliver research, implementation evidence, residual limitations and next benchmark design. This release is transport/protocol correctness evidence, not measured evidence of higher LLM repair success.

Native acceptance uses a fresh pair-dev DSH process, the linked plugin and real Agent/Session/Subagent/ToolRuntime services in a temporary fixture. Record the selected model, actual child routes, tool calls and persisted terminal board; do not equate a captain's first idle edge with completion of the pair. Internal mocked-host suites alone cannot satisfy this acceptance. Global settings remain unchanged.

Large multi-Driver worktree orchestration remains a separately specified next architecture: isolated candidate branches, explicit base/spec/read/write scopes, serial integration and fresh regression checks. Adding parallel writers to this shared directory is outside these invariants, even though broad refactoring is authorized.
