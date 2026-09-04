/**
 * Host wiring for CE detection: the derived namespace the Settings card reads,
 * and the probe request it triggers.
 *
 * The awkward part, stated plainly. The Settings card is browser code with
 * exactly three services (`slots`, `locale`, `settingsScope`); it cannot read a
 * filesystem, and this plugin ships no Remote of its own. So a "Detect" button
 * cannot detect anything by itself. What it can do is write a value. The loop
 * is therefore:
 *
 *   card writes ceProbeToken -> host observes the committed change ->
 *   host probes the filesystem -> host writes the result into a SECOND,
 *   host-owned namespace -> card renders it.
 *
 * Settings as a one-shot RPC. It costs one commit round-trip and needs the
 * token compare below to avoid re-probing on its own write. The alternative —
 * a typert-generated Remote, as `dsh-host-plugin-inventory` has — is an order
 * of magnitude more machinery for one button, and is the documented upgrade
 * path rather than a thing V5.3 pretends to need.
 *
 * The derived facts live in their own namespace on purpose: `pair-programming`
 * is a section humans hand-edit in `~/.dsh/settings.yaml`, and probe output is
 * not configuration.
 *
 * @module dsh-pair-programming/integrations/ce-install
 */
import z from 'schemastery';
import { probeCe, probeSummary } from './ce-probe.js';
import { catalogCost } from './ce-catalog.js';

/** Host-written, card-read. Never merged into the user's own config section. */
export const CE_STATUS_NAMESPACE = 'pair-programming-ce';

/** The derived shape. Every field is output; nothing here is user intent. */
export const CeStatusSchema = z.object({
  status: z.string().default('unknown'),
  summary: z.string().default('no probe has run yet'),
  path: z.string().default(''),
  version: z.string().default(''),
  commitSha: z.string().default(''),
  source: z.string().default(''),
  skillCount: z.number().default(0),
  fingerprint: z.string().default(''),
  reviewNeeded: z.boolean().default(false),
  probedAt: z.number().default(0),
  token: z.string().default(''),
  lane: z.string().default('off'),
  catalogSkills: z.number().default(0),
  catalogChars: z.number().default(0),
  catalogTokens: z.number().default(0),
});

/** Flatten a probe result into the derived section (schemastery wants scalars). */
export function toStatusSection(probe, token = '', lane = 'off') {
  const cost = catalogCost(lane);
  return {
    lane: String(lane),
    catalogSkills: cost.skills,
    catalogChars: cost.chars,
    catalogTokens: cost.approxTokens,
    status: String(probe?.status ?? 'unknown'),
    summary: probeSummary(probe),
    path: String(probe?.path ?? ''),
    version: String(probe?.version ?? ''),
    commitSha: String(probe?.commitSha ?? ''),
    source: String(probe?.source ?? ''),
    skillCount: Number(probe?.skillCount ?? 0),
    fingerprint: String(probe?.fingerprint ?? ''),
    reviewNeeded: probe?.reviewNeeded === true,
    probedAt: Number(probe?.probedAt ?? 0),
    token: String(token ?? ''),
  };
}

/**
 * Register the derived namespace and keep it in step with probe requests.
 *
 * @param {object} settings - the host settings service.
 * @param {object} resolved - this plugin's mutable resolved config.
 * @param {{probe?:Function, logger?:object}} [deps] - injected for tests.
 * @returns {{probeNow:Function, onSettingsCommitted:Function, current:Function}}
 */
export function installCeStatus(settings, resolved, deps = {}) {
  const probe = deps.probe ?? probeCe;
  const scope = settings.register(CE_STATUS_NAMESPACE, CeStatusSchema, { base: toStatusSection(undefined, '', resolved.ceLanes) });
  let last = { token: undefined, path: undefined, lane: undefined };
  let latest;
  let inFlight;

  const probeNow = async (token) => {
    const result = await probe({ cePath: resolved.cePath });
    latest = result;
    // `replace` rather than `update`: a probe result is whole, and a merge
    // would leave fields of a previous detection standing beside a later
    // "not found" — a status that is half stale is worse than either half.
    await scope.replace(toStatusSection(result, token, resolved.ceLanes));
    return result;
  };

  const request = (token) => {
    // Serialize: a user clicking twice must not race two probes into the same
    // namespace, where the loser's write could land last.
    inFlight = Promise.resolve(inFlight)
      .catch(() => {})
      .then(() => probeNow(token))
      .catch((error) => {
        deps.logger?.warn?.(`pair-programming: CE probe failed: ${String(error)}`);
      });
    return inFlight;
  };

  return {
    /** Probe once, unconditionally (install time, tests, the tool surface). */
    probeNow: (token) => request(token ?? resolved.ceProbeToken ?? ''),
    /**
     * React to a committed change of the plugin's own settings section. Only a
     * new probe token or a changed path re-probes: every other settings edit,
     * and our own write to the derived namespace, must not.
     */
    onSettingsCommitted: (next) => {
      const token = String(next?.ceProbeToken ?? '');
      const path = String(next?.cePath ?? '');
      const lane = String(next?.ceLanes ?? 'off');
      if (last.token === undefined && last.path === undefined) {
        last = { token, path, lane };
        return undefined;
      }
      const reprobe = token !== last.token || path !== last.path;
      const laneMoved = lane !== last.lane;
      last = { token, path, lane };
      if (reprobe) return request(token);
      // A lane switch changes what the catalog would cost without changing
      // what is on disk. Republish the derived facts; do not re-probe.
      if (laneMoved) return scope.replace(toStatusSection(latest, token, lane)).catch(() => {});
      return undefined;
    },
    /** The derived section as it currently stands. */
    current: () => scope.get(),
  };
}
