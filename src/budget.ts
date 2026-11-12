/**
 * Listing-budget accounting (Layer 2) — Phase 2a.
 *
 * Three numbers travel together, because any one alone is misleading:
 *
 *   rawChars        name + description + when_to_use for every skill, plus
 *                   name + description for every command, before truncation
 *   effectiveChars  what the listing can carry: the per-entry cap applied, plus
 *                   per-entry formatting overhead, skills *and* commands
 *   overhead        chars/entry, with `calibrated` and, when false, the reason
 *
 * Command discovery exists because commands share this budget. Omitting them
 * understated total listing cost by 75,073 chars on the real machine.
 */

import type { Contract } from './contracts/loader.js';
import { listingText } from './parser/skill.js';
import type { Budget, Skill, SlashCommand } from './types.js';
import { displayName } from './types.js';

export interface BudgetOptions {
  /** `--budget`: pin the limit in characters. */
  overrideChars?: number;
  /** `--context-window`: derive 1% of this window instead of the documented default. */
  contextWindow?: number;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Slash-commands, which share the same budget as skills. */
  commands?: readonly SlashCommand[];
}

export interface LimitResolution {
  limitChars: number;
  limitSource: string;
  exact: boolean;
  /** True only when the limit was measured against a running host. */
  verified: boolean;
  note: string;
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
  for (const command of options.commands ?? []) {
    rawChars += command.name.length + command.description.length;
    effectiveChars += command.name.length + Math.min(command.description.length, cap) + overhead;
  }

  const limit = resolveLimit(contract, options);
  const percentUsed = limit.limitChars > 0 ? (effectiveChars / limit.limitChars) * 100 : 0;

  return {
    limitChars: limit.limitChars,
    limitSource: limit.limitSource,
    exact: limit.exact,
    limitVerified: limit.verified,
    limitNote: limit.note,
    rawChars,
    effectiveChars,
    percentUsed,
    perEntryCapChars: cap,
    overhead: {
      charsPerEntry: overhead,
      calibrated: lb.overheadCalibrated,
      note: lb.overheadNote,
      reason: lb.calibrationUnavailableReason,
    },
  };
}

export function resolveLimit(
  contract: Contract,
  options: BudgetOptions = {},
): LimitResolution {
  const lb = contract.listingBudget;

  if (typeof options.overrideChars === 'number' && options.overrideChars > 0) {
    return {
      limitChars: options.overrideChars,
      limitSource: '--budget',
      exact: true,
      verified: false,
      note: 'pinned by flag; not verified against the host',
    };
  }

  const env = options.env ?? process.env;
  const rawEnv = env[lb.envOverride];
  if (typeof rawEnv === 'string' && rawEnv.trim() !== '') {
    const parsed = Number.parseInt(rawEnv, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return {
        limitChars: parsed,
        limitSource: lb.envOverride,
        exact: true,
        verified: false,
        note: 'read from the environment variable; host enforcement not measured (Phase 2a host unavailable)',
      };
    }
  }

  if (typeof options.contextWindow === 'number' && options.contextWindow > 0) {
    return {
      limitChars: Math.floor(options.contextWindow * lb.fraction * lb.charsPerToken),
      limitSource: `1% of a ${options.contextWindow}-token context window at ~${lb.charsPerToken} chars/token`,
      exact: false,
      verified: false,
      note: 'derived estimate; the chars-per-token ratio is an assumption',
    };
  }

  const v = lb.limitVerification;
  return {
    limitChars: lb.absoluteDefaultChars,
    limitSource: `documented default (${lb.absoluteDefaultChars.toLocaleString('en-US')} chars)`,
    exact: true,
    verified: v.measured,
    note: v.measured ? 'measured against the host' : lb.calibrationUnavailableReason,
  };
}
