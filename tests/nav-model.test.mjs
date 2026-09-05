/**
 * The navigator-route watcher, and the two bugs that made its fallback dead.
 *
 * Both were found by reading, not by a failing test, and both are the same
 * family this codebase keeps paying for: a mechanism that is present, looks
 * right, and never runs.
 *
 *  1. `markNavFallback` read `lastStatus`, which was declared INSIDE
 *     `installNavModelStatus`. Every real quota fallback therefore raised
 *     `ReferenceError: lastStatus is not defined` — and because the scheduler
 *     calls it immediately before the respawn and the captain wake, the throw
 *     aborted both. The seat was never moved to the captain's route, the
 *     captain was never told, and the outer handler logged "member error
 *     telemetry failed" at warn level. The feature was dead exactly when it
 *     was needed.
 *  2. `onSettingsCommitted` re-tested on `token !== ''` rather than on the
 *     token having CHANGED. Once the user pressed Test the token stayed set
 *     for the life of the process, so every unrelated settings commit — a
 *     tddMode edit, a budget edit — spent a `resolveCallConfig` and rewrote
 *     the derived namespace.
 */
import { installNavModelStatus, markNavFallback, NAV_STATUS_NAMESPACE } from '../lib/integrations/nav-model.js';

function harness({ resolve } = {}) {
  const writes = [];
  const scope = {
    get: () => ({}),
    watch: () => () => {},
    update: async () => {},
    replace: async (section) => { writes.push(section); },
  };
  let registeredNs;
  const settings = { register: (ns) => { registeredNs = ns; return scope; } };
  const resolved = { navigatorModel: 'deepseek/deepseek-chat', navigatorModelProbeToken: '', navigatorEffort: '' };
  const resolves = [];
  const api = installNavModelStatus(settings, resolved, {
    resolve: resolve ?? (async (request) => { resolves.push(request); return { provider: 'deepseek', model: 'deepseek-chat' }; }),
    logger: { warn: () => {} },
  });
  return { api, writes, resolves, resolved, ns: () => registeredNs };
}

export async function run(check) {
  /* ---- the derived namespace ------------------------------------------- */
  const h = harness();
  check(h.ns() === NAV_STATUS_NAMESPACE, 'the verdict lands in its own host-written namespace');

  /* ---- a route test publishes a whole verdict --------------------------- */
  await h.api.validateNow('t-1');
  check(h.resolves.length === 1, 'a test resolves the seat route once');
  check(h.writes.length === 1 && h.writes[0].ok === true, 'and publishes a whole verdict, not a merge');
  check(h.writes[0].detail.includes('deepseek'), 'naming the route it resolved');

  /* ---- only a CHANGED token re-tests ------------------------------------ */
  const t = harness();
  await t.api.validateNow('t-1');
  const afterFirst = t.resolves.length;
  t.api.onSettingsCommitted({ navigatorModelProbeToken: 't-1', navigatorModel: 'a', navigatorEffort: '' });
  check(t.resolves.length === afterFirst, 'the first committed snapshot is a baseline, not a request');
  t.api.onSettingsCommitted({ navigatorModelProbeToken: 't-1', navigatorModel: 'a', navigatorEffort: '' });
  check(t.resolves.length === afterFirst, 'an unchanged token does not re-test — our own write must not feed itself');
  // The regression: an unrelated settings edit arrives with the SAME token.
  t.api.onSettingsCommitted({ navigatorModelProbeToken: 't-1', navigatorModel: 'a', navigatorEffort: 'high' });
  check(t.resolves.length === afterFirst, 'editing another field with the same token spends no resolve — the bug was testing on "token is set" instead of "token changed"');
  await t.api.onSettingsCommitted({ navigatorModelProbeToken: 't-2', navigatorModel: 'a', navigatorEffort: 'high' });
  check(t.resolves.length === afterFirst + 1, 'a new token from the Test button tests exactly once');

  /* ---- the fallback marker may never reach its caller ------------------- */
  const f = harness();
  let threw = false;
  try { await markNavFallback('quota exhausted on the premium route'); } catch { threw = true; }
  check(!threw, 'marking a quota fallback does not throw — the scheduler calls it immediately before the respawn and the captain wake');
  const marked = f.writes.at(-1);
  check(marked?.fallbackActive === true, 'the marker publishes the sticky fallback flag');
  check(marked?.fallbackDetail.includes('quota exhausted'), 'with the detail the card renders');
  check(typeof marked?.provider === 'string' && typeof marked?.ok === 'boolean', 'and carries the whole status shape, so the namespace never holds half a verdict');

  /* ---- and it stays contained when the scope refuses the write ---------- */
  const brokenScope = { get: () => ({}), watch: () => () => {}, update: async () => {}, replace: async () => { throw new Error('provider is read-only'); } };
  installNavModelStatus({ register: () => brokenScope }, { navigatorModel: '', navigatorModelProbeToken: '' }, { resolve: async () => ({}), logger: { warn: () => {} } });
  let threwOnBroken = false;
  try { await markNavFallback('x'); } catch { threwOnBroken = true; }
  check(!threwOnBroken, 'a read-only settings provider costs the badge, never the recovery');

  /* ---- a successful re-test clears the sticky fallback ------------------ */
  const c = harness();
  await markNavFallback('quota exhausted');
  await c.api.validateNow('t-9');
  check(c.writes.at(-1).fallbackActive === false, 'a route that resolves again clears the sticky fallback — the user re-selected and it works');
}
