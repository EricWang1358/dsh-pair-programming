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
