/**
 * Plugin configuration schema.
 *
 * @module dsh-pair-programming/config
 */
import z from '@deepseek-ai/schemastery';

export const Config = z.object({
  /** State directory name under the captain's workspace (default `.pair-programming`). */
  stateDir: z.string().default('.pair-programming'),
  /** `ctx.subagents` provider used to spawn members; must support continuable children, personas, and toolFilter (default `spawn`). */
  memberProvider: z.string().default('spawn'),
  /** Optional model override applied to every member. */
  memberModel: z.string(),
  /** Member delegation depth cap (default `1`; `0` forbids delegation entirely). */
  memberMaxDepth: z.number().default(1),
  /** Team size cap in members (default `4`). */
  maxMembers: z.number().default(4),
  /** Hard cap on Pair Cycles per task before the captain must consult the user (default `12`). */
  maxCyclesPerTask: z.number().default(12),
  /** Hard cap on OPEN non-P0 risk tickets, team-wide; a P0 raise bypasses it (default `15`). */
  maxOpenRisks: z.number().default(15),
  planningMaxArbitrations: z.number().default(2),
  /** Default team mode: `full` or `light` (default `full`). */
  defaultMode: z.string().default('full'),
  /** TDD enforcement: `enforce` (tool-mandated RED->GREEN->REFACTOR, invariant I7), `coach` (recommended, both orders accepted), `off` (legacy report cycle). Default `enforce`. */
  tddMode: z.string().default('enforce'),
  /** Default pairing style: `traditional` | `strong` | `ping-pong` (default `traditional`). */
  pairStyle: z.string().default('traditional'),
  /** Cycle budget for a spike task (its own small fixed timebox; default `2`). */
  spikeMaxCycles: z.number().default(2),
  /** Green-build rule: `pair_stop` requires fresh whole-suite green evidence when changes were accepted (default `true`). */
  greenBuildOnStop: z.boolean().default(true),
  /** Comma-separated Definition-of-Done gate item ids; empty = protocol defaults. */
  dod: z.string().default(''),
  /** Optional Definition-of-Done command the gate executes itself; unset = evidence stays honor-system (M7'). */
  dodCommand: z.string(),
  /** Enable the L2 repository evidence cache (default `true`). */
  evidenceCache: z.boolean().default(true),
  /** Prompt-section order for the usage policy (default `118`). */
  promptSectionOrder: z.number().default(118),
  /** Register the `/pair` slash command and gesture boundary (default `true`). */
  slashCommand: z.boolean().default(true),
});
