/**
 * Plugin configuration schema.
 *
 * @module dsh-pair-programming/config
 */
import z from 'schemastery';
import { DEFAULTS } from './defaults.js';

export const Config = z.object({
  /** State directory name under the captain's workspace (default `.pair-programming`). */
  stateDir: z.string().default(DEFAULTS.stateDir),
  /** `ctx.subagents` provider used to spawn members; must support continuable children, personas, and toolFilter (default `spawn`). */
  memberProvider: z.string().default(DEFAULTS.memberProvider),
  /** Optional model override applied to every member. */
  memberModel: z.string(),
  /** Member delegation depth cap (default `1`; `0` forbids delegation entirely). */
  memberMaxDepth: z.number().default(DEFAULTS.memberMaxDepth),
  /** Team size cap in members (default `4`). */
  maxMembers: z.number().default(DEFAULTS.maxMembers),
  /** Hard cap on Pair Cycles per task before the captain must consult the user (default `12`). */
  maxCyclesPerTask: z.number().default(DEFAULTS.maxCyclesPerTask),
  /** Hard cap on OPEN non-P0 risk tickets, team-wide; a P0 raise bypasses it (default `15`). */
  maxOpenRisks: z.number().default(DEFAULTS.maxOpenRisks),
  planningMaxArbitrations: z.number().default(DEFAULTS.planningMaxArbitrations),
  /** Default team mode: `full` (Driver+Navigator+Challenger) or `light` (Driver+Navigator). Default `light` — see REDESIGN-v3 R1. */
  defaultMode: z.string().default(DEFAULTS.defaultMode),
  /** TDD enforcement: `enforce` (tool-mandated RED->GREEN->REFACTOR, invariant I7), `coach` (recommended, both orders accepted), `off` (legacy report cycle). Default `enforce`. */
  tddMode: z.string().default(DEFAULTS.tddMode),
  /** Default pairing style: `traditional` | `strong` | `ping-pong` (default `traditional`). */
  pairStyle: z.string().default(DEFAULTS.pairStyle),
  /** Cycle budget for a spike task (its own small fixed timebox; default `2`). */
  spikeMaxCycles: z.number().default(DEFAULTS.spikeMaxCycles),
  /** Green-build rule: `pair_stop` requires fresh whole-suite green evidence when changes were accepted (default `true`). */
  greenBuildOnStop: z.boolean().default(DEFAULTS.greenBuildOnStop),
  /** Comma-separated Definition-of-Done gate item ids; empty = protocol defaults. */
  dod: z.string().default(DEFAULTS.dod),
  /** Optional Definition-of-Done command the gate executes itself; unset = evidence stays honor-system (M7'). */
  dodCommand: z.string(),
  /** Enable the L2 repository evidence cache (default `true`). */
  evidenceCache: z.boolean().default(DEFAULTS.evidenceCache),
  /** Prompt-section order for the usage policy (default `118`). */
  promptSectionOrder: z.number().default(DEFAULTS.promptSectionOrder),
  /** Register the `/pair` slash command and gesture boundary (default `true`). */
  slashCommand: z.boolean().default(DEFAULTS.slashCommand),
  /** N5 liveness heartbeat period in ms: every tracked team is swept for stalled mailboxes. `0` disables (default `60000`). */
  heartbeatMs: z.number().default(DEFAULTS.heartbeatMs),
  /** Oracle-first protocol (N1): a task's acceptance oracle is frozen before the Driver implements (default `true`). */
  oracleFirst: z.boolean().default(DEFAULTS.oracleFirst),
  /** Member lifetime: `cycle` respawns members per Pair Cycle from a board digest (R2), `session` keeps one durable seat per role (default `cycle`). */
  memberLifetime: z.string().default(DEFAULTS.memberLifetime),
  /** Freezes of one task's oracle before a captain override is required (default `3`). Motivated by a measured session that spent 2h 16min re-forking a single oracle 6+ times — a soft budget that names a real escape hatch beats an infinite recursion. */
  oracleForkBudget: z.number().default(DEFAULTS.oracleForkBudget),
});
