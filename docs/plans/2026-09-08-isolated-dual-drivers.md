# Optional isolated dual Drivers

User-approved contract: retain the default single Driver; opt in to two Drivers
with separate Git worktrees and branches, a shared Navigator, and serialized
integration. Correctness takes priority over latency. Native acceptance must use
DSH `pair-dev`, `opencode-go-muse/muse-spark-1.3-contributor`.

## Implementation units

- U1: real Git workspace transactions and scope conflicts. Snapshot candidates
  without changing their reviewed worktree/index; test merges in a disposable
  worktree before advancing the canonical branch. Failed verification or drift
  must preserve the canonical tree and candidate evidence.
- U2: native DSH member lifecycle with explicit cwd. The installed continuable
  API cannot override cwd. Use public Agent creation/resume and public delegation
  composition helpers, plugin-origin messages, owned handles and durable member
  records. Keep ordinary continuable members unchanged.
- U3: task-scoped ownership and workspace routing. Centralize board/mail; bind
  Driver mutations to owner/attempt. Declare read/write/resource scopes, queue
  conflicts, preserve per-task review backpressure, and verify each candidate in
  the worktree where it was produced.
- U4: candidate integration tool and completion chain. Require a current review
  and candidate gate, run all affected frozen oracles plus a whole-suite command
  on the merge result, record the candidate and merge commits. Unintegrated work
  cannot complete or unblock dependents. Final recertification uses the canonical
  tree and retains the existing review-to-credential attempt chain.
- U5: documentation, regression checks and native DSH acceptance. Observe two
  distinct Driver cwd/session identities and overlapping work, final merged
  behavior, conflict refusal, and cleanup. Report measured latency without
  claiming a quality or speed improvement from one smoke test.

## Boundaries

Separate Git worktrees prevent accidental same-directory overwrites; they are
not OS sandboxes or proof of semantic independence. Scope declarations and actual
diff checks complement independent oracle/review and integration regressions.
No shell-based security isolation claim. Reject dirty/non-Git starts explicitly;
never silently commit user work. Unknown task scopes serialize conservatively.

Current implementation route: native inline/subagents; DSH Muse selection applies
to acceptance, not to the coding harness. No push or release requested. Preserve
the pre-existing `lib/protocol/disclosure.js` changes.

## Evidence and progress

U1–U4 implemented and committed through e924760. Native lifecycle, cold resume
and the two-task integration/completion chain have evidence records. U5 documentation and bounded verification are delivered. Full PM dual-task model
acceptance remains unproven; further full DSH runs were stopped at the user's explicit cost constraint. This is not a stable-mode release signoff.

Additional user-approved units implemented:
- U6: evidence-backed requirement discovery, Captain PM triage, non-claimable
  drafts, priority with reasons, independent QA preparation and bounded status.
- U7: repair a bad checkpoint command on the same cycle, retaining the frozen
  oracle, historical failures and budgets, and requiring new GREEN.
- Native failure follow-up: pre-claim editor protection; precise tool/path
  guidance; safely reclaim amended preparation with integrated dependencies;
  reduce isolated Driver tools to their actual responsibilities.

The final design and evidence index are in
[dual-drivers.md](../diagnostics/2026-09-08-dual-drivers.md). The native checkpoint-repair pipeline passed; offline verification reported
1438/0 across 45 suites on the final frozen working tree. Product-model orchestration limitations and the user's
cost policy are recorded there; future full model trials are not automatic.

- U8: frozen local design and cross-use-case collaboration contracts; joint AC allocation, dependency ancestry, evidence binding, and task-specific QA/Driver handoff. Offline handler regressions cover rejection without board mutation. No new model trial.
