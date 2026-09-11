/**
 * The runtime settings surface: the user-adjustable slice of the protocol
 * configuration, exposed through the host `settings` service (dsh-settings).
 *
 * Layering (host semantics): schema defaults -> the composed YAML entry (this
 * plugin's cordis config = the deployment base) -> user overrides edited in
 * the Settings UI or ~/.dsh/settings.yaml. Writes always land in the user
 * layer; a reset returns to the composed value.
 *
 * Only fields that every consumer reads at call time (tool execution, team
 * start) are exposed here — `stateDir`, `slashCommand`, `promptSectionOrder`,
 * `evidenceCache`, member-spawn fields and `dod`-adjacent boot behavior stay
 * YAML-only because they are wired once at apply() time — `heartbeatMs` is one
 * of those: its interval is created during apply(), so a live override would
 * display a knob that does nothing until the host restarts.
 *
 * The install glue is exported separately so unit tests can drive the hooks
 * without a live cordis context.
 *
 * @module dsh-pair-programming/settings
 */
import z from 'schemastery';
import { DEFAULTS, TDD_MODES, PAIR_STYLES, TEAM_MODES, MEMBER_LIFETIMES, CE_LANES, CE_SOLO_LANES } from './defaults.js';
import { DEFAULT_DOD } from './protocol/gate.js';
import { commandShapeError } from './protocol/command-shape.js';

/** The settings namespace (lowercase hyphenated, per the host's contract). */
export const SETTINGS_NAMESPACE = 'pair-programming';

const DOD_ITEMS = new Set(DEFAULT_DOD);

/** The user-editable schema. Shape mirrors the YAML keys, same defaults. */
export const PairSettingsSchema = z.object({
  /** 'enforce' | 'coach' | 'off' — how strictly RED->GREEN->REFACTOR is tool-enforced. */
  tddMode: z.string().default(DEFAULTS.tddMode),
  /** 'traditional' | 'strong' | 'ping-pong' pairing style for new teams. */
  pairStyle: z.string().default(DEFAULTS.pairStyle),
  /** 'solo' | 'light' | 'full' default team mode. Solo (Captain + isolated SPEC) is the default. */
  defaultMode: z.string().default(DEFAULTS.defaultMode),
  /** Experimental: new teams use two isolated Driver worktrees once an integration command is configured. */
  experimentalDualDrivers: z.boolean().default(DEFAULTS.experimentalDualDrivers),
  /** Experimental: a short per-step section with the full protocol delivered at pair_start. */
  /** Whole-suite command run on every dual-Driver candidate integration. Empty keeps the experiment inactive. */
  dualDriverIntegrationCommand: z.string().default(DEFAULTS.dualDriverIntegrationCommand),
  /** Oracle-first protocol: a task freezes its acceptance oracle before the Driver implements. */
  oracleFirst: z.boolean().default(DEFAULTS.oracleFirst),
  /** 'cycle' respawns members per Pair Cycle from the board digest; 'session' keeps one durable seat per role. */
  memberLifetime: z.string().default(DEFAULTS.memberLifetime),
  /** Model for the acceptance-definition seat (navigator / solo SPEC): "provider/model" or a bare model id; empty = the captain's route. */
  navigatorModel: z.string().default(DEFAULTS.navigatorModel),
  /** Reasoning effort for that seat: empty = the captain route's effort, `default` = the target model's adapter default, otherwise an adapter-published effort id. */
  navigatorEffort: z.string().default(DEFAULTS.navigatorEffort),
  /** Opaque token: changing it requests one route validation. The card's test button writes it. */
  navigatorModelProbeToken: z.string().default(DEFAULTS.navigatorModelProbeToken),
  /** Freezes of one task's oracle before a captain override is required. */
  oracleForkBudget: z.number().default(DEFAULTS.oracleForkBudget),
  /** Hard Pair-Cycle budget per task. */
  maxCyclesPerTask: z.number().default(DEFAULTS.maxCyclesPerTask),
  /** Team-wide cap on OPEN non-P0 risk tickets; a P0 raise bypasses it. */
  maxOpenRisks: z.number().default(DEFAULTS.maxOpenRisks),
  planningMaxArbitrations: z.number().default(DEFAULTS.planningMaxArbitrations),
  /** Cycle budget for a spike task. */
  spikeMaxCycles: z.number().default(DEFAULTS.spikeMaxCycles),
  /** Green-build rule on pair_stop. */
  greenBuildOnStop: z.boolean().default(DEFAULTS.greenBuildOnStop),
  /** Comma-separated DoD item ids; empty = protocol defaults. */
  dod: z.string().default(DEFAULTS.dod),
  /** Optional DoD command the gate executes itself; unset = honor-system evidence (M7'). */
  dodCommand: z.string(),
  /** 'off' | 'captain' | 'advisory' | 'full' — how much of the Compound Engineering allowlist is exposed. */
  ceLanes: z.string().default(DEFAULTS.ceLanes),
  /** 'off' | 'gesture' | 'curated' | 'full' — what a session with no live pair team sees. */
  ceSoloLane: z.string().default(DEFAULTS.ceSoloLane),
  /** Explicit path to a local CE checkout; empty auto-detects. */
  cePath: z.string().default(DEFAULTS.cePath),
  /** Opaque token: changing it requests one fresh read-only probe. The card's Detect button writes it. */
  ceProbeToken: z.string().default(DEFAULTS.ceProbeToken),
});

/** Parse the comma-separated DoD list into the runtime shape (array | undefined). */
export function parseDod(raw) {
  const items = String(raw ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * Map a validated settings snapshot onto the mutable `resolved` config object
 * every tool reads at call time. Only hot-safe fields are copied.
 */
export function toRuntimeSettings(snapshot) {
  return {
    tddMode: TDD_MODES.includes(snapshot.tddMode) ? snapshot.tddMode : DEFAULTS.tddMode,
    pairStyle: PAIR_STYLES.includes(snapshot.pairStyle) ? snapshot.pairStyle : DEFAULTS.pairStyle,
    defaultMode: TEAM_MODES.includes(snapshot.defaultMode) ? snapshot.defaultMode : DEFAULTS.defaultMode,
    experimentalDualDrivers: snapshot.experimentalDualDrivers === true,
    dualDriverIntegrationCommand: snapshot.dualDriverIntegrationCommand ?? DEFAULTS.dualDriverIntegrationCommand,
    oracleFirst: snapshot.oracleFirst !== false,
    memberLifetime: MEMBER_LIFETIMES.includes(snapshot.memberLifetime) ? snapshot.memberLifetime : DEFAULTS.memberLifetime,
    navigatorModel: snapshot.navigatorModel ?? DEFAULTS.navigatorModel,
    navigatorEffort: snapshot.navigatorEffort ?? DEFAULTS.navigatorEffort,
    navigatorModelProbeToken: snapshot.navigatorModelProbeToken ?? DEFAULTS.navigatorModelProbeToken,
    oracleForkBudget: snapshot.oracleForkBudget,
    maxCyclesPerTask: snapshot.maxCyclesPerTask,
    maxOpenRisks: snapshot.maxOpenRisks,
    planningMaxArbitrations: snapshot.planningMaxArbitrations,
    spikeMaxCycles: snapshot.spikeMaxCycles,
    greenBuildOnStop: snapshot.greenBuildOnStop,
    dod: parseDod(snapshot.dod),
    dodCommand: snapshot.dodCommand,
    ceLanes: CE_LANES.includes(snapshot.ceLanes) ? snapshot.ceLanes : DEFAULTS.ceLanes,
    ceSoloLane: CE_SOLO_LANES.includes(snapshot.ceSoloLane) ? snapshot.ceSoloLane : DEFAULTS.ceSoloLane,
    cePath: snapshot.cePath ?? DEFAULTS.cePath,
    ceProbeToken: snapshot.ceProbeToken ?? DEFAULTS.ceProbeToken,
  };
}

/** Reject a schema-valid section the protocol could not act on. */
export function settingsValueError(value) {
  if (!TDD_MODES.includes(value.tddMode)) return `tddMode must be one of ${TDD_MODES.join('/')}`;
  if (!PAIR_STYLES.includes(value.pairStyle)) return `pairStyle must be one of ${PAIR_STYLES.join('/')}`;
  if (!TEAM_MODES.includes(value.defaultMode)) return `defaultMode must be one of ${TEAM_MODES.join('/')}`;
  if (value.memberLifetime !== undefined && !MEMBER_LIFETIMES.includes(value.memberLifetime)) return `memberLifetime must be one of ${MEMBER_LIFETIMES.join('/')}`;
  if (!Number.isInteger(value.maxCyclesPerTask) || value.maxCyclesPerTask < 1) return 'maxCyclesPerTask must be an integer >= 1';
  if (!Number.isInteger(value.spikeMaxCycles) || value.spikeMaxCycles < 1) return 'spikeMaxCycles must be an integer >= 1';
  if (!Number.isInteger(value.maxOpenRisks) || value.maxOpenRisks < 1) return 'maxOpenRisks must be an integer >= 1';
  if (!Number.isInteger(value.planningMaxArbitrations) || value.planningMaxArbitrations < 1) return 'planningMaxArbitrations must be an integer >= 1';
  for (const item of parseDod(value.dod) ?? []) {
    if (!DOD_ITEMS.has(item)) return `unknown DoD item "${item}" (known: ${[...DOD_ITEMS].join(', ')})`;
  }
  if (value.dodCommand !== undefined && value.dodCommand !== '' && typeof value.dodCommand !== 'string') return 'dodCommand must be a string command, or unset/empty';
  // The gate executes this verbatim. A prose value would read as a red suite
  // at every gate check, which is the same false-verdict shape that produced
  // the measured checkpoint REJECT.
  if (typeof value.dodCommand === 'string' && value.dodCommand.trim() !== '') {
    const shape = commandShapeError(value.dodCommand, { field: 'dodCommand' });
    if (shape !== undefined) return shape;
  }
  if (value.ceLanes !== undefined && !CE_LANES.includes(value.ceLanes)) return `ceLanes must be one of ${CE_LANES.join('/')}`;
  if (value.dualDriverIntegrationCommand !== undefined && typeof value.dualDriverIntegrationCommand !== 'string') return 'dualDriverIntegrationCommand must be a string command, or empty';
  if (typeof value.dualDriverIntegrationCommand === 'string' && value.dualDriverIntegrationCommand.trim() !== '') {
    const shape = commandShapeError(value.dualDriverIntegrationCommand, { field: 'dualDriverIntegrationCommand' });
    if (shape !== undefined) return shape;
  }
  if (value.ceSoloLane !== undefined && !CE_SOLO_LANES.includes(value.ceSoloLane)) return `ceSoloLane must be one of ${CE_SOLO_LANES.join('/')}`;
  return undefined;
}

/**
 * Compose the base layer from the current resolved config (the deployment's
 * own YAML values win over schema defaults; user overrides win over these).
 */
export function settingsEntry(resolved, rawDod) {
  return {
    tddMode: resolved.tddMode,
    pairStyle: resolved.pairStyle,
    defaultMode: resolved.defaultMode,
    experimentalDualDrivers: resolved.experimentalDualDrivers,
    dualDriverIntegrationCommand: resolved.dualDriverIntegrationCommand,
    oracleFirst: resolved.oracleFirst,
    memberLifetime: resolved.memberLifetime,
    oracleForkBudget: resolved.oracleForkBudget,
    maxCyclesPerTask: resolved.maxCyclesPerTask,
    spikeMaxCycles: resolved.spikeMaxCycles,
    maxOpenRisks: resolved.maxOpenRisks,
    planningMaxArbitrations: resolved.planningMaxArbitrations,
    greenBuildOnStop: resolved.greenBuildOnStop,
    dod: String(rawDod ?? '').trim(),
    dodCommand: resolved.dodCommand,
    navigatorModel: resolved.navigatorModel,
    navigatorEffort: resolved.navigatorEffort,
    navigatorModelProbeToken: resolved.navigatorModelProbeToken,
    ceLanes: resolved.ceLanes,
    ceSoloLane: resolved.ceSoloLane,
    cePath: resolved.cePath,
    ceProbeToken: resolved.ceProbeToken,
  };
}

/**
 * Register the namespace on the host settings service and keep the mutable
 * `resolved` object authoritative. Call only when a settings provider exists
 * (`ctx.inject(['settings'], ...)`); without one the plugin keeps working
 * exactly as composed.
 *
 * @param {{ installSection: Function }} settings - the host settings service.
 * @param {object} owner - the plugin's cordis context (the section's owner).
 * @param {object} resolved - the plugin's mutable resolved config.
 * @param {string|undefined} rawDod - the YAML-level `dod` string (pre-parse).
 */
export function installPairSettings(settings, owner, resolved, rawDod, onCommitted) {
  let source = () => settingsEntry(resolved, rawDod);
  const sync = () => {
    Object.assign(resolved, toRuntimeSettings(source()));
    // One hook, called after `resolved` is authoritative, so a consumer that
    // reacts to a settings change (the CE probe) reads the same object every
    // tool call reads rather than a snapshot that can already be stale.
    try { onCommitted?.(resolved); } catch { /* a consumer must never break a settings commit */ }
  };
  settings.installSection(owner, SETTINGS_NAMESPACE, PairSettingsSchema, settingsEntry(resolved, rawDod), {
    setSource: (current) => { source = current; sync(); },
    onChange: () => { sync(); },
    validate: (value) => {
      const err = settingsValueError(value);
      if (err !== undefined) throw new Error(`pair-programming settings: ${err}`);
    },
  });
  return { sync };
}
