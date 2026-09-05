/**
 * dsh-pair-programming public types.
 * @module dsh-pair-programming
 */
import type { Context } from '@deepseek-ai/cordis';

/** Plugin configuration. */
export interface Config {
  stateDir?: string;
  memberProvider?: string;
  memberModel?: string;
  memberMaxDepth?: number;
  maxMembers?: number;
  maxCyclesPerTask?: number;
  maxOpenRisks?: number;
  planningMaxArbitrations?: number;
  dodCommand?: string;
  defaultMode?: 'solo' | 'light' | 'full';
  tddMode?: 'enforce' | 'coach' | 'off';
  pairStyle?: 'traditional' | 'strong' | 'ping-pong';
  spikeMaxCycles?: number;
  greenBuildOnStop?: boolean;
  dod?: string;
  oracleFirst?: boolean;
  memberLifetime?: 'cycle' | 'session';
  navigatorModel?: string;
  navigatorEffort?: string;
  navigatorModelProbeToken?: string;
  maxTokenResumes?: number;
  maxCarriedLessons?: number;
  ceLanes?: 'off' | 'captain' | 'advisory' | 'full';
  ceSoloLane?: 'off' | 'gesture' | 'curated' | 'full';
  cePath?: string;
  ceProbeToken?: string;
  oracleForkBudget?: number;
  heartbeatMs?: number;
  workingLeaseMs?: number;
  evidenceCache?: boolean;
  promptSectionOrder?: number;
  slashCommand?: boolean;
}

export declare const name = "pair-programming";
export declare const inject: string[];
export declare const Config: import('schemastery').z<Config>;
export declare function apply(ctx: Context, config: Config): void;
