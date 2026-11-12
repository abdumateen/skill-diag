/**
 * Listing-budget accounting (Layer 2).
 *
 * Two numbers are always reported, because conflating them is how a measurement
 * tool starts lying:
 *
 *   rawChars       sum of name + description + when_to_use, before truncation
 *   effectiveChars what the listing can actually carry: the per-entry cap applied,
 *                  plus per-entry formatting overhead
 *
 * The overhead constant is **uncalibrated in Phase 1**. It is carried as 0 and
 * flagged, so effectiveChars currently equals the capped raw total and nobody
 * mistakes it for a measured host value.
 */

import type { Contract } from './contracts/loader.js';
import { listingText } from './parser/skill.js';
import type { Budget, Skill } from './types.js';
import { displayName } from './types.js';

export interface BudgetOptions {
  /** `--budget`: pin the limit in characters. */
  overrideChars?: number;
  /** `--context-window`: derive 1% of this window instead of the 15,000 default. */
  contextWindow?: number;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export function resolveContextWindow(contract: Contract, options: BudgetOptions): number {
  const fromFlag = options.contextWindow;
  if (typeof fromFlag === 'number' && fromFlag > 0) return fromFlag;
  return contract.listingBudget.defaultContextWindow;
}

export function computeBudget(
  skills: readonly Skill[],
  contract: Contract,
  options: BudgetOptions = {},
): Budget {
  const lb = contract.listingBudget;
  const cap = lb.perEntryCapChars;
  const overhead = lb.overheadCharsPerEntry;

  let rawChars = 0;
  let effectiveChars = 0;
  for (const skill of skills) {
    const nameLen = displayName(skill).length;
    const textLen = listingText(skill).length;
    rawChars += nameLen + textLen;
    effectiveChars += nameLen + Math.min(textLen, cap) + overhead;
  }

  const { limitChars, limitSource, exact } = resolveLimit(contract, options);
  const percentUsed = limitChars > 0 ? (effectiveChars / limitChars) * 100 : 0;

  return {
    limitChars,
    limitSource,
    exact,
    rawChars,
    effectiveChars,
    percentUsed,
    perEntryCapChars: cap,
    overhead: {
      charsPerEntry: overhead,
      calibrated: lb.overheadCalibrated,
      note: lb.overheadNote,
    },
  };
}

export function resolveLimit(
  contract: Contract,
  options: BudgetOptions = {},
): { limitChars: number; limitSource: string; exact: boolean } {
  const lb = contract.listingBudget;
  if (typeof options.overrideChars === 'number' && options.overrideChars > 0) {
    return { limitChars: options.overrideChars, limitSource: '--budget', exact: true };
  }
  const env = options.env ?? process.env;
  const rawEnv = env[lb.envOverride];
  if (typeof rawEnv === 'string' && rawEnv.trim() !== '') {
    const parsed = Number.parseInt(rawEnv, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return { limitChars: parsed, limitSource: lb.envOverride, exact: true };
    }
  }
  if (typeof options.contextWindow === 'number' && options.contextWindow > 0) {
    return {
      limitChars: Math.floor(options.contextWindow * lb.fraction * lb.charsPerToken),
      limitSource: `1% of a ${options.contextWindow}-token context window at ~${lb.charsPerToken} chars/token`,
      exact: false,
    };
  }
  return {
    limitChars: lb.absoluteDefaultChars,
    limitSource: `contract default (${lb.absoluteDefaultChars.toLocaleString('en-US')} chars)`,
    exact: true,
  };
}
