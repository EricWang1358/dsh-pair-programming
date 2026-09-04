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
  memberLifetime: 'cycle',
  oracleForkBudget: 3,
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
  };
}
