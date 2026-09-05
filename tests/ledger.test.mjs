/**
 * The ledger, checked against the code it describes.
 *
 * AGENTS.md is prose, and prose drifts. That is tolerable for most of it — a
 * stale "open" line costs someone a grep. It is NOT tolerable for entries that
 * carry an *executable instruction*, because a reader who follows a superseded
 * one does damage. M11' is the measured case: its original fix options ("delete
 * the appendPairEvent dead path", "register a pair event namespace") were
 * reversed by 0.12.4 when the guard turned out to be load-bearing, and until
 * the reversal was written onto M11' itself, a reader following the number
 * would have traded session-resume for a UI panel nobody has.
 *
 * So this suite pins only the destructive edges — the ones where being wrong
 * costs more than a grep:
 *
 *   - an entry marked ⛔ must still be marked ⛔;
 *   - an entry claiming a capability is OPEN must still find that capability
 *     absent from the code;
 *   - an entry claiming one LANDED must still find it present.
 *
 * Deliberately narrow. Pinning every ledger line to code would make the ledger
 * unmaintainable and this suite a second source of truth; the point is that
 * the few lines which can cause harm cannot rot unnoticed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

export async function run(check) {
  let ledger;
  try {
    ledger = read('../../AGENTS.md');
  } catch {
    check(true, 'no project ledger beside the package — this suite is a no-op outside the workspace checkout');
    return;
  }

  /* ---- the convention itself ------------------------------------------- */
  check(ledger.includes('推翻标记必须写在被推翻的那一行上'),
    'the ledger states where a supersession marker goes — a reversal recorded only in the new ruling is invisible to someone reading by number');
  check(ledger.includes('空号永久保留') || ledger.includes('永不复用'),
    'and that numbers are append-only, because renumbering invalidates every existing reference');

  /* ---- M11': the one entry whose old instruction is destructive --------- */
  // The ENTRY, not the first mention — the reading convention above cites M11'
  // as its worked example, and slicing from that citation would assert against
  // the header instead of against the entry it is supposed to guard.
  const entryAt = ledger.indexOf("\nM11'（");
  check(entryAt > 0, "the M11' entry itself is findable by its own line, not only by a passing mention");
  const m11 = ledger.slice(entryAt, entryAt + 2600);
  check(m11.includes('⛔'), "M11' still carries its do-not-execute marker");
  check(m11.includes('0.12.4'), "M11' names the ruling that reversed it");
  check(/推翻/.test(m11), "M11' says it was reversed, not merely deprioritised");
  check(m11.includes('events.test.mjs'), "M11' points at the machine guard that will fail if the harness ever changes");

  // The reversal is only true while the code still behaves this way. If a
  // future DSH accepts plugin event vocabulary, events.test.mjs fails first —
  // but pin the shape here too, so the ledger and the code cannot part quietly.
  const events = read('../lib/events.js');
  check(events.includes('KNOWN_SESSION_EVENT_TYPES'),
    'the guard M11\' describes is still the mechanism in lib/events.js');
  check(/LOAD|承重|load-bearing|assertEventsSupported/i.test(events),
    'and the module still explains why dropping the events is correct, so the next reader does not "fix" it');

  /* ---- open vs landed claims that would mislead ------------------------- */
  const lifecycle = read('../lib/tools/lifecycle.js');
  check(lifecycle.includes('pair_rotate is refused'),
    "M2' is recorded as open, and pair_rotate does still refuse — if this fails, the ledger owes a status change");

  const typecheck = read('../scripts/typecheck.mjs');
  const handlesSpawnFailure = /EPERM|SKIPPED \(spawn blocked\)/.test(typecheck);
  const m10 = ledger.match(/M10'（[\s\S]*?(?=\n###)/)?.[0] ?? '';
  check(handlesSpawnFailure && m10.includes('状态: 已落地'),
    "M10' landed: both the ledger and spawn-failure classifier must agree");

  const gateExec = read('../lib/tools/gate-exec.js');
  check(gateExec.includes('dodCommand'),
    "M7' is recorded as landed, and the gate does execute a configured command");

  const members = read('../lib/runtime/members.js');
  check(members.includes('installRetiredInboxGuard') && members.includes('readRetiredMemberIds'),
    "the retired-members deny-list has a real consumer, as the M2' foundation note's correction says");
  check(!members.includes('ctx.subagents.followup'),
    "M19' is recorded as fixed, and the phantom is gone from the wake path");
}
