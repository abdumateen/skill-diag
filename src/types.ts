/**
 * Shared data model for Phase 1 (Tier 1 static linter).
 *
 * The skill record mirrors what the Claude Code loader actually reads, so the
 * check engine can report on the thing the host sees rather than on an idealised
 * schema. `source` is carried through because plugin skills are namespaced and
 * the incumbent tool withholds checks from them; per-finding source is what makes
 * that coverage gap measurable.
 */

export type Severity = 'error' | 'warning' | 'info';

/** Where a skill was discovered. Mirrors the host's priority tiers. */
export type SkillSource = 'user' | 'project' | 'plugin';

export interface YamlFailure {
  line: number;
  column: number;
  message: string;
}

export interface Skill {
  /** Frontmatter `name`, trimmed, or null when absent/empty. */
  readonly name: string | null;
  /** On-disk parent directory name — the loader compares `name` against this. */
  readonly folderName: string;
  /** Absolute path to SKILL.md. */
  readonly path: string;
  readonly source: SkillSource;
  /** Plugin key (`plugin@marketplace`) when source is plugin. */
  readonly plugin?: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly body: string;
  readonly yamlError?: YamlFailure;
  /** 1-based line of a frontmatter key, for precise findings. */
  readonly keyLines: Readonly<Record<string, number>>;
}

/**
 * How the host addresses this skill. Plugin skills are `plugin:skill`; user and
 * project skills are addressed by name alone, which is what decides shadowing.
 */
export function commandName(skill: Skill): string {
  const base = skill.name ?? skill.folderName;
  return skill.plugin ? `${skill.plugin}:${base}` : base;
}

/** The bare skill name, ignoring the plugin namespace. */
export function displayName(skill: Skill): string {
  return skill.name ?? skill.folderName;
}

/** Match a `--why` target against name, folder name, or namespaced command name. */
export function matchSkills(skills: readonly Skill[], target: string): Skill[] {
  return skills.filter(
    (s) =>
      s.name === target ||
      s.folderName === target ||
      (s.plugin ? `${s.plugin}:${s.name ?? s.folderName}` === target : false),
  );
}

export interface Fix {
  kind: string;
  field?: string;
  from?: string;
  to?: string;
  confidence: 'certain' | 'likely' | 'heuristic' | 'diagnostic';
}

export interface Finding {
  readonly checkId: string;
  readonly tier: 1 | 2;
  readonly severity: Severity;
  readonly skillPath: string | null;
  readonly skillName: string;
  /** Source of the skill the finding is about; null for corpus-level findings. */
  readonly skillSource: SkillSource | null;
  readonly line?: number;
  readonly column?: number;
  readonly message: string;
  readonly fix?: Fix;
}

export interface Overhead {
  charsPerEntry: number;
  /** False until the §11.2 calibration harness measures it (Phase 2a). */
  calibrated: boolean;
  note: string;
  /** Why it is uncalibrated, when it is. Never omitted from output. */
  reason?: string;
}

export interface Budget {
  limitChars: number;
  limitSource: string;
  exact: boolean;
  /** True only when the limit was measured against the host, not read from docs. */
  limitVerified: boolean;
  limitNote: string;
  rawChars: number;
  effectiveChars: number;
  percentUsed: number;
  perEntryCapChars: number;
  overhead: Overhead;
}

/** A slash-command definition: not linted, but it shares the listing budget. */
export interface SlashCommand {
  /** Namespaced invocation name, e.g. `foo:bar` for `commands/foo/bar.md`. */
  readonly name: string;
  /** Invocation name without the plugin namespace — the stem the incumbent costs. */
  readonly stem: string;
  readonly path: string;
  readonly source: SkillSource;
  readonly plugin?: string;
  readonly description: string;
  /** name + min(description, per-entry cap) — what it costs the listing. */
  readonly discoveryCost: number;
}

export interface CorpusReport {
  host: string;
  hostVersionRange: string;
  contextWindow: number;
  skills: readonly Skill[];
  commands: readonly SlashCommand[];
  findings: readonly Finding[];
  budget: Budget;
}

/** What the host does with an over-budget listing, once calibrated. */
export type DropOrder =
  | 'least-recently-invoked'
  | 'reverse-alphabetical'
  | 'reverse-registration'
  | 'never-invoked-first'
  | 'unknown';

/** How much the drop-order calibration can be trusted. */
export type DropConfidence = 'high' | 'medium' | 'low' | 'none';

/** How the drop order was established. */
export type DropCalibrationMethod = '5-trial-harness' | 'manual-script' | 'unverified';

export const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;
export const PER_ENTRY_CAP = 1536;
