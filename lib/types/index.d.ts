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
  defaultMode?: 'full' | 'light';
  evidenceCache?: boolean;
  promptSectionOrder?: number;
  slashCommand?: boolean;
}

export declare const name = "pair-programming";
export declare const inject: string[];
export declare const Config: import('@deepseek-ai/schemastery').z<Config>;
export declare function apply(ctx: Context, config: Config): void;
