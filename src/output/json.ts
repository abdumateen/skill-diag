/**
 * Machine-readable output (spec §13). This is the shape CI consumes, so it is
 * written in one place and both `--json` and the parity tests read it.
 *
 * Two fields go beyond the spec's example because the Phase 1 acceptance
 * criterion depends on them: `findings[].source` (user vs plugin — the whole
 * coverage claim rests on that split) and `budget.overhead` (stated as
 * uncalibrated rather than silently zero).
 */

import type { CorpusReport, Finding } from '../types.js';

export const REPORT_VERSION = '1';

export interface JsonFinding {
  checkId: string;
  tier: 1 | 2;
  severity: Finding['severity'];
  skill: string;
  source: Finding['skillSource'];
  path: string | null;
  line?: number;
  column?: number;
  message: string;
  fix?: Finding['fix'];
}

export interface JsonReport {
  version: string;
  tool: { name: string; version: string };
  host: string;
  contextWindow: number;
  generatedAt: string;
  summary: {
    skills: number;
    commands: number;
    errors: number;
    warnings: number;
    runtimeFindings: number;
    exitCode: 0 | 1 | 2;
  };
  coverage: { userSkills: number; pluginSkills: number };
  budget: {
    limitChars: number;
    limitSource: string;
    exact: boolean;
    rawChars: number;
    effectiveChars: number;
    percentUsed: number;
    perEntryCapChars: number;
    overhead: { charsPerEntry: number; calibrated: boolean; note: string };
  };
  findings: JsonFinding[];
}

export function exitCodeFor(report: CorpusReport, strict: boolean): 0 | 1 | 2 {
  const errors = report.findings.filter((f) => f.severity === 'error').length;
  const warnings = report.findings.filter((f) => f.severity === 'warning').length;
  if (errors > 0) return 1;
  if (strict && warnings > 0) return 2;
  return 0;
}

export function toJsonReport(
  report: CorpusReport,
  opts: { version: string; strict: boolean; generatedAt?: string },
): JsonReport {
  const errors = report.findings.filter((f) => f.severity === 'error').length;
  const warnings = report.findings.filter((f) => f.severity === 'warning').length;
  return {
    version: REPORT_VERSION,
    tool: { name: 'skill-diag', version: opts.version },
    host: report.host,
    contextWindow: report.contextWindow,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    summary: {
      skills: report.skills.length,
      commands: 0,
      errors,
      warnings,
      runtimeFindings: 0,
      exitCode: exitCodeFor(report, opts.strict),
    },
    coverage: {
      userSkills: report.skills.filter((s) => s.source !== 'plugin').length,
      pluginSkills: report.skills.filter((s) => s.source === 'plugin').length,
    },
    budget: {
      limitChars: report.budget.limitChars,
      limitSource: report.budget.limitSource,
      exact: report.budget.exact,
      rawChars: report.budget.rawChars,
      effectiveChars: report.budget.effectiveChars,
      percentUsed: Number(report.budget.percentUsed.toFixed(1)),
      perEntryCapChars: report.budget.perEntryCapChars,
      overhead: report.budget.overhead,
    },
    findings: report.findings.map((f) => ({
      checkId: f.checkId,
      tier: f.tier,
      severity: f.severity,
      skill: f.skillName,
      source: f.skillSource,
      path: f.skillPath,
      ...(f.line !== undefined ? { line: f.line } : {}),
      ...(f.column !== undefined ? { column: f.column } : {}),
      message: f.message,
      ...(f.fix ? { fix: f.fix } : {}),
    })),
  };
}

export function stringify(json: JsonReport): string {
  return `${JSON.stringify(json, null, 2)}\n`;
}
