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
import { analyzeRouting, DEFAULT_ROUTING_CONFIG, type RoutingConfig } from '../model/routing.js';
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
  /** Routing parameters for the Phase 2b warnings; defaults are published values. */
  routing?: RoutingConfig;
  /** Findings destined for a claude.ai upload path (Phase 3a). */
  uploadMode?: boolean;
  /** Promote routing-model findings from `info` to their natural severity (Phase 3c). */
  strictRaw?: boolean;
}

export function runChecks(skills: readonly Skill[], options: RunOptions): CorpusReport {
  const { contract } = options;
  const commands = options.commands ?? [];
  const budget = computeBudget(skills, contract, options);
  const contextWindow = resolveContextWindow(contract, options);
  const routing = analyzeRouting(skills, options.routing ?? DEFAULT_ROUTING_CONFIG);
  const ctx: CheckContext = {
    skills,
    contract,
    budget,
    contextWindow,
    routing,
    uploadMode: options.uploadMode === true,
    strictRaw: options.strictRaw === true,
  };
  const checks = options.checks ?? ALL_CHECKS;
  const findings: Finding[] = [];
  for (const check of checks) findings.push(...check.run(ctx));
  return {
    host: contract.host,
    hostVersionRange: contract.versionRange,
    contextWindow,
    skills,
    commands,
    findings: sortFindings(findings),
    budget,
  };
}
