/**
 * One allowed write set, computed in one place.
 *
 * The measured failure (B3). A probe file at
 * `scratch/regression/pool-link-guard.mjs` was legal at the PROPOSAL layer —
 * which checks `task.scope.writes` only while `scope.declared` is true and
 * otherwise defers to the cycle's own `proposal.files` — legal in the WRITE
 * GUARD, which used the same `declared` fallback, and then REJECTED at
 * INTEGRATION with `Candidate escapes declared write scope`. That third layer
 * keyed on `task.scope.writes.length`, so a card created with write_paths but
 * without read_paths/resources was judged by its envelope at integration and by
 * its proposals everywhere else. The team's only way past the contradiction was
 * to move its probes out of the repository.
 *
 * Three layers, three rules, one question. So the question is answered here,
 * once, and all three layers call this module.
 *
 * Semantics, decided rather than inferred:
 *
 * - A NON-EMPTY `scope.writes` is the task's write ENVELOPE, and it wins. It is
 *   what the captain declared when the card was created, it bounds what a cycle
 *   may PROPOSE and what may be WRITTEN, and it is the same set integration
 *   checks the whole candidate against. Whether the other two scope arrays were
 *   supplied (`scope.declared`) is a parallel-ADMISSION flag — claimEligibility
 *   needs it to serialize two Drivers — and it says nothing about where writes
 *   are allowed. Reading that flag as the write rule is what made the proposal
 *   layer and the guard disagree with integration, so it is not read here.
 * - NO envelope (write_paths omitted or empty — the shape of every board that
 *   never asked for isolation) means the task
 *   declared no bound, so the effective set is what it declared as it ran: the
 *   `proposal.files` of ALL its cycles, not merely the latest. The set is a
 *   property of the TASK because integration snapshots the whole candidate; a
 *   guard narrowed to the current cycle would rebuild the very divergence above
 *   for any task that proposed files in an earlier one.
 * - A frozen oracle's files are ALWAYS allowed. The Navigator authors them
 *   through pair_oracle_write, which cannot reach production source, and the set
 *   is sealed under a digest — so including them grants the Driver nothing it
 *   could not already do, while excluding them would refuse the Navigator's own
 *   artifacts at integration.
 * - A DECLARED DIRECTORY covers its descendants: `scratch/regression` admits
 *   `scratch/regression/pool-link-guard.mjs` without a second declaration.
 *   Matching is on segment boundaries, never on string prefixes.
 *
 * Pure logic, no fs, no exec: the layers that own the filesystem resolve paths
 * themselves and pass workspace-relative names. Normalization mirrors
 * runtime/worktrees.js `pathName` (forward slashes, no trailing slash, folded
 * on Windows) so a name admitted here is the name snapshotCandidate admits.
 *
 * @module dsh-pair-programming/protocol/scope
 */

/** Windows compares paths case-insensitively, and Git folds them there too. */
const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);

/**
 * Normalize one declared scope entry. Deliberately non-throwing: this module
 * answers "is this inside that", and a scope entry that cannot be normalized
 * simply matches nothing rather than becoming a crash inside a write guard.
 */
export function scopePath(value) {
  return fold(String(value ?? '').replaceAll('\\', '/').replace(/\/+$/, ''));
}

/**
 * Whether one workspace-relative path lies inside a declared root. Directory
 * declarations subsume descendants; `scratch/regression-notes` is NOT inside
 * `scratch/regression` just because the text starts the same way.
 */
export function withinScope(allowed, path) {
  const target = scopePath(path);
  if (target === '') return false;
  return (allowed ?? []).some((root) => {
    const base = scopePath(root);
    return base !== '' && (target === base || target.startsWith(`${base}/`));
  });
}

/**
 * The one allowed write set for a task.
 *
 * @param {object} task - the task card, with `scope` and/or `oracle`.
 * @param {object[]} [cycles] - the board's cycles; only this task's are read.
 * @returns {{envelope: string[], allowed: string[], source: 'scope.writes'|'proposal'}}
 *   `envelope` is the task-level bound (empty when the card declares none) and
 *   is what the PROPOSAL layer answers against; `allowed` is what a write may
 *   touch now, and is what the GUARD and INTEGRATION layers answer against.
 */
export function allowedWriteSet(task, cycles = []) {
  const unique = (values) => [...new Set(values.map(scopePath).filter(Boolean))];
  const envelope = unique(task?.scope?.writes ?? []);
  const proposed = unique((cycles ?? [])
    .filter((cycle) => cycle?.taskId === undefined || task?.id === undefined || cycle.taskId === task.id)
    .flatMap((cycle) => cycle?.proposal?.files ?? []));
  // Oracle artifacts are always admitted: the Navigator owns that path, the
  // seal is a digest, and a candidate that carries them must not be refused for
  // carrying the files the verdict is computed from.
  const sealed = unique(task?.oracle?.files ?? []);
  return {
    envelope,
    allowed: envelope.length > 0 ? unique([...envelope, ...sealed]) : unique([...proposed, ...sealed]),
    source: envelope.length > 0 ? 'scope.writes' : 'proposal',
  };
}

/**
 * May this cycle DECLARE these files? The proposal layer's question, and the
 * only one of the three that can be answered before anything is written.
 *
 * It reads the same {@link allowedWriteSet} as the guard and integration, and
 * refuses an escaping file HERE — where the mistake is a declaration rather
 * than a finished candidate — with the remedy in the message. A card that
 * declares no envelope stays free: new files are then declared by the proposal
 * itself, which is the shape most boards use.
 *
 * @returns {string|undefined} a refusal reason, or undefined to admit.
 */
export function proposalScopeError(team, task, cycles, files) {
  if (team?.parallel === undefined) return undefined; // a single-writer board declares no scope
  const { envelope, source } = allowedWriteSet(task, cycles);
  const reserved = ['.git', '.pair-programming', '.pair-oracles', team.parallel.stateRelative]
    .filter(Boolean).map(scopePath);
  for (const value of files ?? []) {
    const path = scopePath(value);
    if (path === '' || path.startsWith('/') || /^[a-z]:/.test(path) || path.split('/').some((part) => part === '..')) {
      return `Proposal must name a literal path inside the workspace: ${String(value)}`;
    }
    if (reserved.some((root) => root !== '' && (path === root || path.startsWith(`${root}/`)))) {
      return `Proposal targets a reserved path: ${String(value)}`;
    }
    if (source === 'scope.writes' && !withinScope(envelope, path)) {
      return `Proposal escapes declared write scope: ${String(value)} is outside this task's write_paths (${envelope.join(', ')}). `
        + 'The task-level scope is what the write guard admits edits against and what integration checks the whole candidate against, '
        + `so declaring the file here would only move the same refusal two steps later. The write set is extensible: pair_task_amend({ task_id: "${String(task?.id)}", write_paths: [...], reason: "..." }) records the extension on the card, refuses an overlap with another Driver's in-flight scope, and invalidates the credentials bound to the old scope.`;
    }
  }
  return undefined;
}
