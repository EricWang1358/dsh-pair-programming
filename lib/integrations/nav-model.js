/**
 * The navigator-model validation watcher: the settings-card "test route"
 * button writes a probe token, the host resolves the acceptance seat's route
 * against the live adapters, and the verdict lands in a derived namespace the
 * card reads back — the exact pattern installCeStatus uses for the CE probe.
 *
 * Why a route test at all: the field is free text (the model catalog dropdown
 * only constrains what it lists), and a mistyped route fails at member spawn —
 * minutes later, inside a protocol cycle. Resolving here costs one
 * resolveCallConfig and reports while the user is still looking at the field.
 *
 * The test validates the COMMITTED values, like the CE probe does: save
 * first, then test.
 *
 * @module dsh-pair-programming/integrations/nav-model
 */
import z from 'schemastery';
import { seatModelRequest, clearNavRouteFallback } from '../runtime/members.js';

/** The derived namespace (lowercase hyphenated, per the host's contract). */
export const NAV_STATUS_NAMESPACE = 'pair-programming-nav';

const NavStatusSchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
  ok: z.boolean(),
  detail: z.string(),
  probedAt: z.number(),
  fallbackActive: z.boolean(),
  fallbackDetail: z.string(),
});

function toStatus(request, route, error, token) {
  const base = { provider: '', model: '', reasoningEffort: '', ok: true, detail: '', probedAt: Date.now() };
  if (error !== undefined) return { ...base, ok: false, detail: String(error?.message ?? error) };
  if (request.provider === undefined && request.model === undefined && request.reasoningEffort === undefined) {
    return { ...base, detail: '无覆盖——该席位继承队长的实时路由，无需验证' };
  }
  return {
    ...base,
    provider: route.provider,
    model: route.model,
    reasoningEffort: route.reasoningEffort === undefined ? '' : String(route.reasoningEffort),
    detail: '路由可用：' + route.provider + '/' + route.model
      + (route.reasoningEffort === undefined ? '' : '（effort ' + String(route.reasoningEffort) + '）'),
  };
}

/**
 * Install the navigator-route validation watcher. Reads the committed
 * settings on every token change, resolves the acceptance seat's route
 * through the host llm service, and publishes the verdict into the derived
 * namespace. Serialized like the CE probe: a double click must not race two
 * verdicts into one namespace.
 */
// Module-level, not install-local: the scheduler and the lifecycle detect the
// quota death in contexts that never see the settings service, so the marker
// has to be writable through a plain import.
let installedScope = undefined;
let fallbackState = { active: false, detail: '' };
// Module-level for the same reason as `installedScope`: markNavFallback reads
// it, and that function is called from the scheduler, which never sees the
// settings service. It used to be declared inside installNavModelStatus, so
// every real fallback threw `ReferenceError: lastStatus is not defined` —
// see the fix note on markNavFallback.
let lastStatus = { provider: '', model: '', reasoningEffort: '', ok: true, detail: '', probedAt: 0 };

export function installNavModelStatus(settings, resolved, deps = {}) {
  const resolve = deps.resolve ?? ((request, signal) => deps.llm.resolveCallConfig(request, signal));
  const scope = settings.register(NAV_STATUS_NAMESPACE, NavStatusSchema, {
    base: { provider: '', model: '', reasoningEffort: '', ok: true, detail: '尚未测试——保存后点「测试路由」。', probedAt: 0, fallbackActive: false, fallbackDetail: '' },
  });
  installedScope = scope;
  lastStatus = { provider: '', model: '', reasoningEffort: '', ok: true, detail: '尚未测试——保存后点「测试路由」。', probedAt: 0 };
  let last = { token: undefined, model: undefined, effort: undefined };
  let inFlight;

  const validateNow = async (token) => {
    const request = seatModelRequest(resolved, 'navigator');
    let result;
    let error;
    try {
      result = await resolve(request);
    } catch (e) {
      error = e;
    }
    // `replace` rather than `update`: a verdict is whole, and a merge would
    // let a previous route's fields stand beside a later refusal. A SUCCESSFUL
    // resolve clears the sticky fallback — the user re-selected and the route
    // works again; an error preserves it.
    if (error === undefined) clearNavRouteFallback();
    if (error === undefined) fallbackState = { active: false, detail: '' };
    const status = toStatus(request, result, error, token);
    lastStatus = { ...status, fallbackActive: fallbackState.active, fallbackDetail: fallbackState.detail };
    await scope.replace(lastStatus);
    return result;
  };

  const request = (token) => {
    inFlight = Promise.resolve(inFlight)
      .catch(() => {})
      .then(() => validateNow(token))
      .catch((error) => {
        deps.logger?.warn?.('pair-programming: navigator route test failed: ' + String(error));
      });
    return inFlight;
  };

  return {
    validateNow: (token) => request(token ?? resolved.navigatorModelProbeToken ?? ''),
    markFallback: (detail) => markNavFallback(detail),
    /**
     * React to a committed change of the plugin's own settings section. Only
     * a new probe token re-tests; our own write to the derived namespace must
     * not loop, and neither must unrelated edits.
     */
    onSettingsCommitted: (next) => {
      const token = String(next?.navigatorModelProbeToken ?? '');
      const model = String(next?.navigatorModel ?? '');
      const effort = String(next?.navigatorEffort ?? '');
      if (last.token === undefined && last.model === undefined && last.effort === undefined) {
        last = { token, model, effort };
        return undefined;
      }
      // The token must have CHANGED, not merely be non-empty. Testing on
      // `token !== ''` re-resolved the model on every unrelated settings
      // commit for the rest of the process: once the user presses Test the
      // token stays set forever, so editing tddMode — or any other field —
      // spent a resolve and rewrote the derived namespace. This is the same
      // guard shape ce-install.js uses, for the same reason: our own write
      // must not feed itself, and neither must somebody else's edit.
      const changed = token !== last.token;
      last = { token, model, effort };
      // A model/effort edit lands through the same commit as its own values —
      // the token is the explicit test request, and testing the freshly saved
      // pair on every save would spend a resolve per keystroke-save.
      if (changed && token !== '') return request(token);
      return undefined;
    },
  };
}

/**
 * Module-level fallback marker for the runtime paths (lifecycle spawn, member
 * recycle, the scheduler's error handler) that detect the quota death without
 * owning the settings scope. No-op before install; the marker survives on the
 * derived namespace's own persistence.
 */
export function markNavFallback(detail) {
  // Contained end to end. This is a display marker called from the scheduler's
  // quota-death path, immediately before the two things that actually matter —
  // respawning the seat on the captain's route and telling the captain. A
  // throw here used to abort that whole block: `lastStatus` was declared
  // inside installNavModelStatus, so every real fallback raised
  // `ReferenceError: lastStatus is not defined`, the recycle never ran, the
  // captain was never woken, and the outer handler logged "member error
  // telemetry failed" at warn level. The feature was dead exactly when it was
  // needed. Nothing in this function may reach its caller again.
  try {
    fallbackState = { active: true, detail: String(detail ?? '') };
    if (installedScope === undefined) return Promise.resolve();
    return Promise.resolve(installedScope.replace({
      ...lastStatus,
      fallbackActive: true,
      fallbackDetail: fallbackState.detail,
      probedAt: Date.now(),
    })).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}