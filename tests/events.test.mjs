/**
 * The session-event guard, and why it must stay closed.
 *
 * This suite exists because the guard looks like a bug. Every `pair/*` event
 * this plugin emits is dropped on this harness, and the obvious "fix" — call
 * `Session.append()` unconditionally, since it accepts any type — would write
 * a session log that `dsh-session-persistence` then REFUSES to interpret,
 * throwing `SessionFormatUnsupportedError` on resume. The cost of the guard is
 * a UI panel nobody has; the cost of removing it is the session.
 *
 * So the assertions below pin the harness facts the guard depends on, against
 * the real packages. If a future DSH admits plugin vocabulary, these fail and
 * the change becomes deliberate instead of accidental.
 */
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
import { readFile } from 'node:fs/promises';
import { appendPairEvent } from '../lib/events.js';

/** Every type this plugin emits, read from the source rather than restated. */
async function emittedTypes() {
  const files = [
    'lib/tools/lifecycle.js', 'lib/tools/flow.js', 'lib/tools/task.js',
    'lib/tools/risk.js', 'lib/tools/arbitrate.js', 'lib/tools/oracle.js',
    'lib/runtime/scheduler.js',
  ];
  const found = new Set();
  for (const file of files) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const match of text.matchAll(/appendPairEvent\([^,]+,[^,]+,\s*'([^']+)'/g)) found.add(match[1]);
  }
  return [...found].sort();
}

export async function run(check) {
  const ours = await emittedTypes();
  check(ours.length >= 5, 'the plugin emits a protocol event vocabulary of its own');
  check(ours.every(type => type.startsWith('pair/')), 'all of it namespaced under pair/');

  /* ---- the harness fact the guard rests on ----------------------------- */
  check(KNOWN_SESSION_EVENT_TYPES instanceof Set && KNOWN_SESSION_EVENT_TYPES.size > 0, 'the harness publishes its event vocabulary as a set');
  check(ours.every(type => !KNOWN_SESSION_EVENT_TYPES.has(type)),
    'and none of this plugin\'s types are in it — downstream plugin events are outside it by construction, so this is the permanent state, not a gap to close');

  /* ---- therefore the guard drops, and must ----------------------------- */
  const appended = [];
  const logged = [];
  const ctx = { logger: { debug: (line) => logged.push(line), warn: () => {} } };
  const session = { append: (type, data) => { appended.push([type, data]); } };

  for (const type of ours) appendPairEvent(ctx, session, type, { x: 1 });
  check(appended.length === 0,
    'every pair/* event is dropped. Appending one would persist a type that dsh-session-persistence refuses to interpret on resume, failing the whole log rather than skipping the event');
  // The dedupe set is module-level, so by the time this suite runs the real
  // vocabulary has already been logged once by earlier suites in this process.
  // Probe types nobody else uses isolate the logging contract from that.
  const probes = ['pair/__probe-alpha', 'pair/__probe-beta'];
  for (const type of probes) appendPairEvent(ctx, session, type, {});
  for (const type of probes) appendPairEvent(ctx, session, type, {});
  check(appended.length === 0, 'an unknown type stays dropped however many times it is emitted');
  check(logged.length === probes.length, 'the drop is logged once per type — a protocol step repeated every cycle does not spam the log');

  /* ---- a recognised type still reaches the session --------------------- */
  const known = [...KNOWN_SESSION_EVENT_TYPES][0];
  appendPairEvent(ctx, session, known, { ok: true });
  check(appended.length === 1 && appended[0][0] === known, 'a type the harness does declare is appended normally — the guard filters, it does not disable');

  /* ---- and a broken session never breaks a tool call ------------------- */
  const throwing = { append: () => { throw new Error('disk full'); } };
  let threw = false;
  try { appendPairEvent(ctx, throwing, known, {}); } catch { threw = true; }
  check(!threw, 'an append failure is contained: a durable record must never break the tool call that produced it');
  check(appendPairEvent({}, undefined, known, {}) === undefined, 'and a missing logger or session is not itself a failure');
}
