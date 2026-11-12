/**
 * Check registry and corpus runner.
 *
 * One list drives every consumer — CLI, `--json`, `--why` and the fixture tests —
 * so a check cannot exist without being run, and cannot be run without being in
 * the registry the tests iterate.
 */

import { computeBudget, resolveContextWindow } from '../budget.js';
import type { BudgetOptions } from '../budget.js';
import type { Contract } from '../contracts/loader.js';
import type { CorpusReport, Finding, Skill } from '../types.js';
import { TIER1_CHECKS, type Check, type CheckContext } from './tier1.js';
import { TIER2_CHECKS } from './tier2.js';

export const ALL_CHECKS: readonly Check[] = [...TIER1_CHECKS, ...TIER2_CHECKS];

export const CHECK_IDS: readonly string[] = ALL_CHECKS.map((c) => c.id);

const SEVERITY_ORDER: Record<Finding['severity'], number> = { error: 0, warning: 1, info: 2 };

export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.checkId.localeCompare(b.checkId) ||
      a.skillName.localeCompare(b.skillName),
  );
}

export interface RunOptions extends BudgetOptions {
  contract: Contract;
  checks?: readonly Check[];
}

export function runChecks(skills: readonly Skill[], options: RunOptions): CorpusReport {
  const { contract } = options;
  const budget = computeBudget(skills, contract, options);
  const contextWindow = resolveContextWindow(contract, options);
  const ctx: CheckContext = { skills, contract, budget, contextWindow };
  const checks = options.checks ?? ALL_CHECKS;
  const findings: Finding[] = [];
  for (const check of checks) findings.push(...check.run(ctx));
  return {
    host: contract.host,
    hostVersionRange: contract.versionRange,
    contextWindow,
    skills,
    findings: sortFindings(findings),
    budget,
  };
}
