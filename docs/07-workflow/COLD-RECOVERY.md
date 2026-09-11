# Cold recovery: how it is measured, and what counts as holding

Issue **#19** owes a measurement, not an assertion: a live board that survives a host
restart. Four claims are checked, and each is a **comparison between two states** —
nobody can make them by reading a transcript afterwards.

## Why the instrument exists

`scripts/cold-recovery-probe.mjs` splits every board into the half that must **not**
change across a restart and the half that must move:

| half | contents | rule |
|---|---|---|
| **settled** | ACCEPT/checkpoint cycles and completed tasks, with owner, oracle digest, verdict, `computed` flag and gate credential | must be **byte-identical** |
| **open** | every other cycle, with its owner | its owner must **move onto a seat that exists after** |

## Procedure

Run the two commands **in the workspace that holds the live team** (the plugin resolves
the workspace from the calling session's cwd — a session in another checkout cannot
adopt it):

```
# 1. before anything else (either side of the restart works; the comparison is
#    pre-adoption -> post-adoption, which is where the owner claims live)
node <plugin>/scripts/cold-recovery-probe.mjs <workspace> --capture .cold-recovery.json

# 2. discover read-only, in the session whose cwd IS that workspace
pair_status({ list_runs: true })

# 3. adopt explicitly (the previous captain id is in the probe output)
pair_start({ resume_team: "<team>", resume_from_captain: "<session-id>" })

# 4. judge
node <plugin>/scripts/cold-recovery-probe.mjs <workspace> --compare .cold-recovery.json
```

`--self-test` checks the fingerprint and the comparison themselves before any of this is
trusted: identical boards agree, timestamp churn does not move them, a moved owner and a
changed verdict signature both do, an open cycle is not in the settled half, a migrated
cycle holds the migration claim, and one left on an old seat fails it.

## The four claims, and what a failure means

1. **The old team is discoverable read-only.** `pair_status(list_runs: true)` lists it with
   its phase, seats and resumability. A board that has vanished is a recovery defect.
2. **An explicit hand-over adopts it.** `pair_start(resume_team, resume_from_captain)`
   succeeds against the *previous* captain id. A refusal here is a recovery defect; a
   refusal naming a live session is the quiescence guard doing its job.
3. **Settled cycles keep owner and signature; the unfinished one moves.** This is the
   claim the probe now *measures*: `settled` must compare equal, and every open cycle's
   owner must resolve to a member present in the after state. An owner left on a retired
   id is the finding this whole exercise is looking for.
4. **The old session does not come back with authority.** The retired generation must
   hold no tool power afterwards; the plugin enforces this through the member's id (see
   `tests/verification.test.mjs`, "a superseded seat cannot land its result").

## Result reporting

Write what happened — success or failure, with symptoms — back into the plan document's
D1 section, and use it to decide whether a `pair_resume_check`-style read-only diagnostic
is worth building. **Do not treat a prepared instrument as a measurement.**
