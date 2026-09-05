/**
 * The CE load ledger: an append-only record of every Compound Engineering
 * skill body this workspace served, and the check that reads it back.
 *
 * Why a ledger rather than a permission. The provider cannot enforce who may
 * load what — `SkillProvider.get` receives `{ cwd, signal }` and no caller
 * identity — so the enforcement point has to be downstream, where identity and
 * board state both exist: the gate. The rule it enforces is narrow and
 * mechanical: if a skill that owns an execution loop or a shipping action was
 * loaded while this task was being built, no gate credential is issued, because
 * a second scheduler behind the same worktree makes the credential's binding
 * meaningless.
 *
 * Attribution honesty. The ledger is keyed by workspace and time, not by seat:
 * `get()` knows the cwd, not which member asked. So a load is attributed to the
 * window it happened in, and the refusal says exactly that rather than naming a
 * seat it cannot actually identify.
 *
 * Failure policy: a ledger write must never break a skill load, and an
 * unreadable ledger must never silently mean "nothing was loaded" — the reader
 * distinguishes an empty ledger from an unreadable one.
 *
 * @module dsh-pair-programming/integrations/ce-ledger
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isWriteLane } from './ce-catalog.js';

/** Where the ledger lives, beside the other workspace-level state. */
export function ceLedgerFileOf(stateRoot) {
  return join(stateRoot, 'ce-loads.jsonl');
}

/**
 * Record one served body. Best effort by contract: the load already happened,
 * and a failed audit line must not turn a working skill into an error.
 */
export async function appendCeLoad(stateRoot, entry) {
  try {
    await mkdir(stateRoot, { recursive: true });
    await appendFile(ceLedgerFileOf(stateRoot), `${JSON.stringify(entry)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read loads at or after `sinceMs`.
 *
 * @returns {Promise<{readable:boolean, loads:object[]}>} `readable:false` means
 *   the ledger exists but could not be parsed or opened — never conflated with
 *   an empty one, because "we could not look" and "nothing happened" must not
 *   produce the same verdict.
 */
export async function readCeLoads(stateRoot, sinceMs = 0) {
  let raw;
  try {
    raw = await readFile(ceLedgerFileOf(stateRoot), 'utf8');
  } catch (error) {
    // A ledger that was never created is the ordinary case: no CE, no loads.
    if (error?.code === 'ENOENT') return { readable: true, loads: [] };
    return { readable: false, loads: [] };
  }
  const loads = [];
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (text === '') continue;
    try {
      const row = JSON.parse(text);
      if (Number(row?.at ?? 0) >= sinceMs) loads.push(row);
    } catch {
      return { readable: false, loads };
    }
  }
  return { readable: true, loads };
}

/**
 * The earliest moment work on one task began — the window a load has to fall
 * into to be attributable to it. Falls back to the task's own creation time so
 * a task with no cycles yet still has a window.
 */
export function taskWindowStart(team, taskId) {
  const cycles = (team?.protocol?.cycles ?? []).filter(c => c.taskId === taskId);
  const opened = cycles.map(c => Number(c.openedAt ?? 0)).filter(Boolean);
  if (opened.length > 0) return Math.min(...opened);
  const task = (team?.tasks ?? []).find(t => t.id === taskId);
  return Number(task?.createdAt ?? 0);
}

/**
 * The gate's verdict on a window's loads.
 *
 * @param {object[]} loads - ledger rows inside the window.
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
export function writeLaneViolation(loads) {
  const offenders = [...new Set((loads ?? []).map(row => String(row?.name ?? '')).filter(isWriteLane))];
  if (offenders.length === 0) return { ok: true };
  return {
    ok: false,
    reason: `Compound Engineering skill(s) that own an execution or shipping loop were loaded while this task was being built: ${offenders.join(', ')}. `
      + 'This plugin never serves those inside a live team, so they came from another skill root. A second loop driving the same worktree makes a gate '
      + 'credential unbindable. Loads are attributed by workspace and time window, NOT by seat, so a legitimate load elsewhere in this workspace lands here too. '
      + 'Ways out, in order: (1) stop serving them — remove that skill root, or let this plugin serve CE, which never exposes them while a team is live; '
      + '(2) if the load was unrelated to this card, move the work onto a fresh task card, since the window is that card\'s own cycles; '
      + '(3) if it really was a second loop on this worktree, the credential is correctly refused — re-verify the work rather than re-issuing it. '
      + 'There is deliberately no exemption flag: a gate that can be waived from inside the run it is gating is not a gate.',
  };
}
