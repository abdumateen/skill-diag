/**
 * SARIF v2.1.0 output (Phase 3b).
 *
 * GitHub Code Scanning is the consumer, so three things are load-bearing:
 *
 * - `rules` is static. Every check id gets an entry whether or not it fired, so
 *   a rule's metadata and its `defaultConfiguration.level` describe the check,
 *   not one run's findings.
 * - `partialFingerprints` is a hash of a finding's identity — check id, path,
 *   line — and of nothing else. Same corpus in, same fingerprints out, so GitHub
 *   updates one alert across commits instead of opening a new one each push.
 * - `--strict` changes the exit code and nothing here. The document a reviewer
 *   reads must not depend on whether the run was allowed to fail.
 */

import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { CHECK_IDS } from '../checks/index.js';
import type { CorpusReport, Finding, Severity } from '../types.js';

export const SARIF_VERSION = '2.1.0';

/** The schema `sarif-multitool` and GitHub both emit for 2.1.0. */
export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';

export type SarifLevel = 'error' | 'warning' | 'note' | 'none';

/**
 * Where a reader goes for the check behind an alert.
 *
 * ponytail: one constant to repoint once the canonical repository URL exists —
 * `package.json` has no `repository` field yet, so this path is a placeholder
 * and the anchors below do not resolve until `docs/checks.md` ships.
 */
export const HELP_URI_BASE = 'https://github.com/skill-diag/skill-diag/blob/main/docs/checks.md';

interface RuleMeta {
  /** One line: what the check detects. */
  readonly short: string;
  /** The failure it prevents, in the same words the human output uses. */
  readonly full: string;
  /** The level the check reports at when it has nothing else to go on. */
  readonly level: SarifLevel;
}

/**
 * Metadata is keyed by check id and never by finding, so adding a check without
 * adding a rule here fails `buildSarif` loudly rather than emitting a result
 * whose `ruleId` resolves to nothing.
 */
const RULE_META: Readonly<Record<string, RuleMeta>> = {
  'yaml-invalid': {
    short: 'SKILL.md frontmatter is not valid YAML',
    full: 'The loader cannot parse the frontmatter block, so the skill does not load at all — it is not listed and never fires.',
    level: 'error',
  },
  'missing-name': {
    short: 'No usable skill name',
    full: 'Frontmatter declares no name and the directory name is not a legal identifier, so the host has nothing to register the skill under.',
    level: 'error',
  },
  'missing-description': {
    short: 'Empty description',
    full: 'The description is what the router matches a prompt against. Empty means the skill exists and can never be selected.',
    level: 'error',
  },
  'name-folder-mismatch': {
    short: 'Frontmatter name does not match the folder',
    full: 'The host compares the declared name against the containing directory and de-registers the skill when they differ.',
    level: 'error',
  },
  'name-invalid': {
    short: 'Name violates the host pattern or length limit',
    full: 'A name outside the contract pattern or over the maximum length is rejected at load, so the skill never becomes addressable.',
    level: 'error',
  },
  'description-too-long': {
    short: 'Description exceeds the contract maximum',
    full: 'A description past the contract maximum is not carried verbatim, so what the router matches on is not what the file says.',
    level: 'error',
  },
  'description-capped': {
    short: 'Listing text is truncated by the per-entry cap',
    full: 'The text past the per-entry cap never reaches the model. The skill still loads; the part of its description that would have routed it does not.',
    level: 'error',
  },
  'budget-exceeded': {
    short: 'Listing budget exceeded',
    full: 'The corpus is over the host listing budget, so the host drops descriptions to fit and an unknown set of skills becomes unrouteable.',
    level: 'error',
  },
  'exact-name-collision': {
    short: 'Two skills resolve to the same command name',
    full: 'Within one namespace the later skill shadows the earlier one; the shadowed skill is installed but unreachable.',
    level: 'error',
  },
  'unknown-field': {
    short: 'Frontmatter field outside the host contract',
    full: 'The host ignores fields it does not define. Under `--upload` the same field is reported as an error when claude.ai rejects it on upload paths.',
    level: 'warning',
  },
  'required-field-missing': {
    short: 'Required frontmatter field absent',
    full: 'The contract for the selected host requires the field; without it the skill does not satisfy the host it targets.',
    level: 'error',
  },
  'context-pressure': {
    short: 'Listing consumes most of the context window',
    full: 'The listing takes so much of the context window that the prompt and the work it asks for are competing with skill descriptions.',
    level: 'warning',
  },
  'routing-health-at-risk': {
    short: 'Estimated top-1 routing accuracy below the warning line',
    full: 'At this corpus size the router is estimated to pick the right skill first less often than the warning threshold. Reported as note in SARIF unless --strict-raw is passed.',
    level: 'warning',
  },
  'routing-health-critical': {
    short: 'Estimated top-1 routing accuracy below the critical floor',
    full: 'At this corpus size the router is estimated to guess more often than to route correctly. Reported as note in SARIF unless --strict-raw is passed.',
    level: 'error',
  },
  'description-collision': {
    short: 'Two skills have near-identical listing text',
    full: 'Reworded duplicates compete for the same prompts, so the second copy adds hazard to the listing and no capability.',
    level: 'warning',
  },
  'trigger-overlap': {
    short: 'Two skills claim the same trigger clause',
    full: "Both skills claim the same activation condition in near-identical words, so whichever wins the tie fires on the other one's prompts.",
    level: 'warning',
  },
  'allowed-tools-mismatch': {
    short: 'Body calls a tool the declaration withholds',
    full: 'The body instructs the agent to use a tool outside `allowed-tools`, so those calls are refused at runtime and the skill fails partway.',
    level: 'warning',
  },
  'body-oversized': {
    short: 'Body exceeds the size the host reads as instructions',
    full: 'Every activation loads the whole body, so the excess is paid on every prompt that reaches the skill.',
    level: 'warning',
  },
  'reference-missing': {
    short: 'Body references a bundled file that is not there',
    full: 'The agent follows the reference and reads nothing, so the skill runs with a missing half of its instructions.',
    level: 'warning',
  },
  'absolute-path': {
    short: 'Body hard-codes a machine-local path',
    full: 'An absolute path is dead for every other machine and ships private layout detail to every consumer of the skill.',
    level: 'warning',
  },
  'docs-in-skill-folder': {
    short: 'Documentation ships inside the skill folder',
    full: 'README and changelog files cost nothing in the listing budget, which is why the budget check never sees them, but they ship to every install.',
    level: 'warning',
  },
};

export interface SarifRule {
  id: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  helpUri: string;
  defaultConfiguration: { level: SarifLevel };
}

/**
 * Every check id, in registry order, as a SARIF rule. Built from `CHECK_IDS` so
 * a check cannot be added to the registry and silently omitted here.
 */
export const SARIF_RULES: readonly SarifRule[] = CHECK_IDS.map((id) => {
  const meta = RULE_META[id];
  if (!meta) throw new Error(`no SARIF rule metadata for check id ${id}`);
  return {
    id,
    shortDescription: { text: meta.short },
    fullDescription: { text: meta.full },
    helpUri: `${HELP_URI_BASE}#${id}`,
    defaultConfiguration: { level: meta.level },
  };
});

/**
 * Checks whose raw severity is model output rather than a fact about the skill.
 * They stay in the document but drop to `note` unless `--strict-raw` asks for
 * the estimate to be treated as a finding in its own right.
 */
export const RAW_ROUTING_CHECKS: ReadonlySet<string> = new Set([
  'routing-health-at-risk',
  'routing-health-critical',
]);

/** This tool's severity on the SARIF scale. `info` is SARIF's `note`. */
export function sarifLevel(severity: Severity): SarifLevel {
  return severity === 'info' ? 'note' : severity;
}

/** The level a finding is written at, given whether raw estimates count. */
export function resultLevel(finding: Finding, strictRaw: boolean): SarifLevel {
  if (!strictRaw && RAW_ROUTING_CHECKS.has(finding.checkId)) return 'note';
  return sarifLevel(finding.severity);
}

/**
 * A finding's path as a SARIF artifact location: forward slashes, relative to
 * the scan root when it lives under it, percent-encoded so spaces stay legal.
 */
export function artifactUri(root: string, filePath: string): string {
  const rel = relative(resolve(root), resolve(filePath));
  const chosen = rel === '' || rel.startsWith('..') ? resolve(filePath) : rel;
  return encodeURI(chosen.replace(/\\/g, '/'));
}

/**
 * Stable across runs and across commits for an unchanged finding. The inputs are
 * the finding's identity only — no timestamp, no run id, no message text — so a
 * reworded message does not orphan an alert a reviewer already triaged.
 */
export function fingerprint(checkId: string, uri: string, line: number): string {
  return createHash('sha256').update(`${checkId}\n${uri}\n${line}`).digest('hex');
}

export interface SarifOptions {
  /** Tool version written to `tool.driver.version`. */
  readonly version: string;
  /** Scan root the artifact URIs are relative to. */
  readonly root: string;
  /** Keep the routing estimates at their raw severity instead of `note`. */
  readonly strictRaw?: boolean;
}

export interface SarifLog {
  $schema: string;
  version: string;
  runs: Array<{
    tool: { driver: { name: string; version: string; rules: readonly SarifRule[] } };
    columnKind: string;
    results: Array<Record<string, unknown>>;
  }>;
}

export function buildSarif(report: CorpusReport, options: SarifOptions): SarifLog {
  const rules = SARIF_RULES;
  const ruleIndex = new Map(rules.map((rule, index) => [rule.id, index]));
  const strictRaw = options.strictRaw === true;

  const results = report.findings.map((finding) => {
    const index = ruleIndex.get(finding.checkId);
    if (index === undefined) throw new Error(`finding for unknown check id ${finding.checkId}`);
    const line = finding.line ?? 1;
    const uri = finding.skillPath ? artifactUri(options.root, finding.skillPath) : null;
    return {
      ruleId: finding.checkId,
      ruleIndex: index,
      level: resultLevel(finding, strictRaw),
      message: { text: finding.message },
      // A corpus-level finding — the budget, the context window, the survival
      // estimate — has no file to point at, and inventing one would put a false
      // location in front of a reviewer. SARIF allows the omission; GitHub drops
      // locationless results, which is the honest outcome for those.
      ...(uri
        ? {
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri },
                  region: { startLine: line, startColumn: finding.column ?? 1 },
                },
              },
            ],
          }
        : {}),
      partialFingerprints: {
        primaryLocationLineHash: fingerprint(finding.checkId, uri ?? '', line),
      },
      properties: {
        tier: finding.tier,
        skill: finding.skillName,
        source: finding.skillSource,
      },
    };
  });

  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: 'skill-diag',
            version: options.version,
            rules,
          },
        },
        // Columns in this tool are JavaScript string indices, and SARIF defaults
        // to UTF-16 code units anyway — stated so the two cannot drift.
        columnKind: 'utf16CodeUnits',
        results,
      },
    ],
  };
}
