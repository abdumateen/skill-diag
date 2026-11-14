/**
 * Machine-readable output (spec §13). This is the shape CI consumes, so it is
 * written in one place and both `--json` and the parity tests read it.
 *
 * Two fields go beyond the spec's example because the Phase 1 acceptance
 * criterion depends on them: `findings[].source` (user vs plugin — the whole
 * coverage claim rests on that split) and `budget.overhead` (stated as
 * uncalibrated rather than silently zero).
 */

import type { DropBehavior, DropSimulation } from '../model/drop.js';
import { simulateDrop } from '../model/drop.js';
import type { RuntimeJoin } from '../model/runtime.js';
import { displayName, matchSkills, type CorpusReport, type Finding } from '../types.js';

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
    limitVerified: boolean;
    limitNote: string;
    rawChars: number;
    effectiveChars: number;
    percentUsed: number;
    perEntryCapChars: number;
    commandCount: number;
    overhead: {
      charsPerEntry: number;
      calibrated: boolean;
      note: string;
      reason?: string;
    };
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
      commands: report.commands.length,
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
      limitVerified: report.budget.limitVerified,
      limitNote: report.budget.limitNote,
      rawChars: report.budget.rawChars,
      effectiveChars: report.budget.effectiveChars,
      percentUsed: Number(report.budget.percentUsed.toFixed(1)),
      perEntryCapChars: report.budget.perEntryCapChars,
      commandCount: report.commands.length,
      overhead: report.budget.overhead,
    },
    findings: report.findings.map(toJsonFinding),
  };
}

export function toJsonFinding(f: Finding): JsonFinding {
  return {
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
  };
}

export interface JsonWhySkill {
  skill: { name: string; path: string; source: string; plugin?: string };
  findings: JsonFinding[];
  listingCost: number;
  dropSimulation: DropSimulation | null;
  runtime?: {
    sessions: number;
    activations: number;
    thiefNeighbor: { name: string; activations: number } | null;
  };
}

export interface JsonWhyReport {
  version: string;
  tool: { name: string; version: string };
  skills: JsonWhySkill[];
}

/** `--why <skill> --json` (schema/report-v1.json). */
export function toWhyJson(
  report: CorpusReport,
  target: string,
  opts: { version: string; dropBehavior: DropBehavior; runtime?: RuntimeJoin | null },
): JsonWhyReport {
  const dropSimulation = simulateDrop(report.skills, report.budget, opts.dropBehavior);
  return {
    version: REPORT_VERSION,
    tool: { name: 'skill-diag', version: opts.version },
    skills: matchSkills(report.skills, target).map((skill) => {
      const name = displayName(skill);
      const desc =
        typeof skill.frontmatter['description'] === 'string'
          ? skill.frontmatter['description']
          : '';
      const when =
        typeof skill.frontmatter['when_to_use'] === 'string'
          ? skill.frontmatter['when_to_use']
          : '';
      const rt = opts.runtime;
      const runtimeRow = rt?.skills.find((row) => row.path === skill.path);
      return {
        skill: {
          name,
          path: skill.path,
          source: skill.source,
          ...(skill.plugin ? { plugin: skill.plugin } : {}),
        },
        findings: report.findings.filter((f) => f.skillPath === skill.path).map(toJsonFinding),
        listingCost: name.length + Math.min(desc.length + when.length, report.budget.perEntryCapChars),
        dropSimulation,
        ...(rt && runtimeRow
          ? {
              runtime: {
                sessions: rt.sessions,
                activations: runtimeRow.activations,
                thiefNeighbor: runtimeRow.thiefNeighbor
                  ? {
                      name: runtimeRow.thiefNeighbor.name,
                      activations: runtimeRow.thiefNeighbor.activations,
                    }
                  : null,
              },
            }
          : {}),
      };
    }),
  };
}

export function stringify(json: unknown): string {
  return `${JSON.stringify(json, null, 2)}\n`;
}
