/**
 * The single source of truth for configuration defaults and enumerations.
 *
 * Why this file exists: every default used to be written three times — the
 * schema in config.js, the `??` fallback in index.js, and the settings schema
 * in settings.js — and the enumerations twice more. Nothing kept them in
 * agreement except attention, and the bug that motivated the v3 redesign was
 * exactly this shape: a `defaultMode` the settings UI displayed but the
 * lifecycle never read. Three declarations of one value are three chances to
 * disagree, and the disagreement is silent.
 *
 * Consumers import from here; none of them restate a literal.
 *
 * @module dsh-pair-programming/defaults
 */

/** Configuration defaults. Every consumer reads these, none redeclares them. */
export const DEFAULTS = Object.freeze({
  stateDir: '.pair-programming',
  memberProvider: 'spawn',
  memberMaxDepth: 1,
  maxMembers: 4,
  maxCyclesPerTask: 12,
  maxOpenRisks: 15,
  planningMaxArbitrations: 2,
  defaultMode: 'solo',
  experimentalDualDrivers: false,
  /** Experimental: a short per-step section with the full protocol delivered at pair_start (issue #90 item 2). */
  experimentalLeanPrompt: false,
  dualDriverIntegrationCommand: '',
  tddMode: 'enforce',
  pairStyle: 'traditional',
  spikeMaxCycles: 2,
  greenBuildOnStop: true,
  dod: '',
  evidenceCache: true,
  promptSectionOrder: 118,
  slashCommand: true,
  heartbeatMs: 120_000,
  workingLeaseMs: 600_000,
  oracleFirst: true,
  memberLifetime: 'session',
  navigatorModel: '',
  navigatorEffort: '',
  navigatorModelProbeToken: '',
  oracleForkBudget: 3,
  maxTokenResumes: 2,
  maxCarriedLessons: 3,
  ceLanes: 'off',
  ceSoloLane: 'off',
  cePath: '',
  ceProbeToken: '',
});

/** TDD enforcement modes. */
export const TDD_MODES = Object.freeze(['enforce', 'coach', 'off']);
/** Pairing styles. */
export const PAIR_STYLES = Object.freeze(['traditional', 'strong', 'ping-pong']);
/**
 * Team compositions, cheapest first.
 *
 * `solo` (default) spawns one short-lived SPEC seat that writes the acceptance
 * oracle with no repository tools at all, then retires; the caller implements
 * against the frozen standard itself. `light` and `full` keep the durable
 * Driver/Navigator(/Challenger) seats of v3 and remain supported, but the
 * measurements say what they cost: on pylint-8898 the paired arm returned a
 * wrong answer for 1.375x the tokens of a lone agent, and across eight rounds
 * the review seats produced zero NO_GO and zero REJECT.
 */
export const TEAM_MODES = Object.freeze(['solo', 'light', 'full']);
/**
 * Compound Engineering delivery lanes (V5.3).
 *
 * `off` (default) contributes no candidates, so a deployment without CE — or
 * one that simply does not want it — pays exactly zero tokens: `dsh-tool-skill`
 * sends no catalog for an empty list. The provider object itself is registered
 * once rather than appearing and disappearing, because a provider that came
 * and went would append a full replacement catalog to every live session on
 * each toggle.
 * `captain` exposes only the user-gesture surface (`modelInvocable: false`),
 * which is still zero model-facing tokens.
 * `advisory` adds the analytical skills to the model catalog.
 * `full` additionally allows the phase-bound persona push.
 */
export const CE_LANES = Object.freeze(['off', 'captain', 'advisory', 'full']);
/**
 * Compound Engineering lanes for a session with NO live pair team (V5.5).
 *
 * Standalone CE and CE-inside-the-protocol are different tools. With no team
 * running there is no single-writer invariant to protect and no completion
 * receipt to keep fresh, so the execution and shipping skills are exactly what
 * CE is for; the moment a team goes live the lane narrows on its own.
 *
 * `off` — nothing. `gesture` — every skill, user-invocable only (zero repeated
 * tokens; a human types `/ce-work`). `curated` — the pair allowlist even
 * outside a team. `full` — every skill in the model catalog: the convenient
 * setting, and the one that costs on every step.
 */
export const CE_SOLO_LANES = Object.freeze(['off', 'gesture', 'curated', 'full']);
/** Member seat lifetimes. */
export const MEMBER_LIFETIMES = Object.freeze(['cycle', 'session']);

/**
 * Apply the defaults to a raw config object, normalizing the enumerations.
 * One function, so `apply()` cannot drift from the schema it is fed.
 */
export function resolveConfig(config = {}) {
  const pick = (key) => (config[key] === undefined ? DEFAULTS[key] : config[key]);
  const oneOf = (key, allowed) => (allowed.includes(config[key]) ? config[key] : DEFAULTS[key]);
  return {
    stateDir: pick('stateDir'),
    memberProvider: pick('memberProvider'),
    memberModel: config.memberModel,
    memberMaxDepth: pick('memberMaxDepth'),
    maxMembers: pick('maxMembers'),
    maxCyclesPerTask: pick('maxCyclesPerTask'),
    maxOpenRisks: pick('maxOpenRisks'),
    planningMaxArbitrations: pick('planningMaxArbitrations'),
    defaultMode: oneOf('defaultMode', TEAM_MODES),
    experimentalDualDrivers: pick('experimentalDualDrivers'),
  experimentalLeanPrompt: pick('experimentalLeanPrompt'),
    dualDriverIntegrationCommand: pick('dualDriverIntegrationCommand'),
    tddMode: oneOf('tddMode', TDD_MODES),
    pairStyle: oneOf('pairStyle', PAIR_STYLES),
    spikeMaxCycles: pick('spikeMaxCycles'),
    greenBuildOnStop: pick('greenBuildOnStop'),
    dodCommand: config.dodCommand,
    evidenceCache: pick('evidenceCache'),
    promptSectionOrder: pick('promptSectionOrder'),
    slashCommand: pick('slashCommand'),
    heartbeatMs: pick('heartbeatMs'),
    workingLeaseMs: pick('workingLeaseMs'),
    oracleFirst: pick('oracleFirst'),
    memberLifetime: oneOf('memberLifetime', MEMBER_LIFETIMES),
    oracleForkBudget: pick('oracleForkBudget'),
    maxTokenResumes: pick('maxTokenResumes'),
    maxCarriedLessons: pick('maxCarriedLessons'),
    // The acceptance seat's route. Absent from this map, a composed
    // `pair-programming.navigatorModel:` in cordis.yml was accepted by the
    // schema and then dropped here — so it never reached `resolved`, never
    // became the settings base layer, and the card showed the schema default
    // while a reset returned to empty instead of to the deployment value.
    // This is the exact drift shape this file's header exists to prevent.
    navigatorModel: config.navigatorModel,
    navigatorEffort: config.navigatorEffort,
    navigatorModelProbeToken: config.navigatorModelProbeToken,
    ceLanes: oneOf('ceLanes', CE_LANES),
    ceSoloLane: oneOf('ceSoloLane', CE_SOLO_LANES),
    cePath: pick('cePath'),
    ceProbeToken: pick('ceProbeToken'),
  };
}
