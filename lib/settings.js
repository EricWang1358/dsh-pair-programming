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
import { DEFAULTS, TDD_MODES, PAIR_STYLES, TEAM_MODES, MEMBER_LIFETIMES } from './defaults.js';
import { DEFAULT_DOD } from './protocol/gate.js';

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
  /** Oracle-first protocol: a task freezes its acceptance oracle before the Driver implements. */
  oracleFirst: z.boolean().default(DEFAULTS.oracleFirst),
  /** 'cycle' respawns members per Pair Cycle from the board digest; 'session' keeps one durable seat per role. */
  memberLifetime: z.string().default(DEFAULTS.memberLifetime),
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
    oracleFirst: snapshot.oracleFirst !== false,
    memberLifetime: MEMBER_LIFETIMES.includes(snapshot.memberLifetime) ? snapshot.memberLifetime : DEFAULTS.memberLifetime,
    oracleForkBudget: snapshot.oracleForkBudget,
    maxCyclesPerTask: snapshot.maxCyclesPerTask,
    maxOpenRisks: snapshot.maxOpenRisks,
    planningMaxArbitrations: snapshot.planningMaxArbitrations,
    spikeMaxCycles: snapshot.spikeMaxCycles,
    greenBuildOnStop: snapshot.greenBuildOnStop,
    dod: parseDod(snapshot.dod),
    dodCommand: snapshot.dodCommand,
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
export function installPairSettings(settings, owner, resolved, rawDod) {
  let source = () => settingsEntry(resolved, rawDod);
  const sync = () => {
    Object.assign(resolved, toRuntimeSettings(source()));
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
