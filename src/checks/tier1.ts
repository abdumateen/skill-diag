/**
 * Tier 1 checks — deterministic hard failures (spec §7.1).
 *
 * Each check is a pure function of the corpus so it can be golden-fixtured in
 * isolation. `run` receives every skill, not one at a time, because cross-skill
 * checks (collisions, the listing budget) cannot be computed from a single file.
 */

import type { Contract } from '../contracts/loader.js';
import { descriptionOf, listingText } from '../parser/skill.js';
import type { Budget, Finding, Skill } from '../types.js';
import { displayName, NAME_MAX, NAME_PATTERN } from '../types.js';

export interface CheckContext {
  skills: readonly Skill[];
  contract: Contract;
  budget: Budget;
  contextWindow: number;
}

export interface Check {
  id: string;
  tier: 1 | 2;
  run: (ctx: CheckContext) => Finding[];
}

interface FindingInput {
  skill: Skill | null;
  message: string;
  severity?: Finding['severity'];
  line?: number;
  column?: number;
  fix?: Finding['fix'];
}

function make(id: string, tier: 1 | 2) {
  return (input: FindingInput): Finding => ({
    checkId: id,
    tier,
    severity: input.severity ?? 'error',
    skillPath: input.skill?.path ?? null,
    skillName: input.skill ? displayName(input.skill) : 'budget',
    skillSource: input.skill?.source ?? null,
    ...(input.line !== undefined ? { line: input.line } : {}),
    ...(input.column !== undefined ? { column: input.column } : {}),
    message: input.message,
    ...(input.fix ? { fix: input.fix } : {}),
  });
}

const NAME_ISSUE = /[^a-z0-9-]/;

export const yamlInvalid: Check = {
  id: 'yaml-invalid',
  tier: 1,
  run: ({ skills }) => {
    const out: Finding[] = [];
    const f = make('yaml-invalid', 1);
    for (const skill of skills) {
      if (!skill.yamlError) continue;
      out.push(
        f({
          skill,
          line: skill.yamlError.line,
          column: skill.yamlError.column,
          message: `line ${skill.yamlError.line}: ${skill.yamlError.message}`,
        }),
      );
    }
    return out;
  },
};

export const missingName: Check = {
  id: 'missing-name',
  tier: 1,
  run: ({ skills }) => {
    const out: Finding[] = [];
    const f = make('missing-name', 1);
    for (const skill of skills) {
      if (skill.yamlError) continue;
      if (skill.name) continue;
      // A valid folder name is a legal fallback, so only an unusable folder is an error.
      if (NAME_PATTERN.test(skill.folderName) && skill.folderName.length <= NAME_MAX) continue;
      out.push(
        f({
          skill,
          line: 1,
          message: `SKILL.md has no name and directory name is not a valid identifier (${skill.folderName})`,
          fix: {
            kind: 'add-frontmatter-field',
            field: 'name',
            to: skill.folderName.toLowerCase().replace(NAME_ISSUE, '-'),
            confidence: 'likely',
          },
        }),
      );
    }
    return out;
  },
};

export const missingDescription: Check = {
  id: 'missing-description',
  tier: 1,
  run: ({ skills }) => {
    const out: Finding[] = [];
    const f = make('missing-description', 1);
    for (const skill of skills) {
      if (skill.yamlError) continue;
      if (descriptionOf(skill).trim().length > 0) continue;
      out.push(
        f({
          skill,
          line: skill.keyLines['description'] ?? 1,
          message: 'description is empty — skill will be unrouteable',
        }),
      );
    }
    return out;
  },
};

export const nameFolderMismatch: Check = {
  id: 'name-folder-mismatch',
  tier: 1,
  run: ({ skills }) => {
    const out: Finding[] = [];
    const f = make('name-folder-mismatch', 1);
    for (const skill of skills) {
      if (skill.yamlError || !skill.name) continue;
      if (skill.name === skill.folderName) continue;
      out.push(
        f({
          skill,
          line: skill.keyLines['name'] ?? 1,
          message: `name: ${skill.name} must match folder name ${skill.folderName}`,
          fix: {
            kind: 'rename-frontmatter-field',
            field: 'name',
            from: skill.name,
            to: skill.folderName,
            confidence: 'certain',
          },
        }),
      );
    }
    return out;
  },
};

export const nameInvalid: Check = {
  id: 'name-invalid',
  tier: 1,
  run: ({ skills, contract }) => {
    const out: Finding[] = [];
    const f = make('name-invalid', 1);
    const pattern = new RegExp(contract.frontmatter.namePattern);
    const max = contract.frontmatter.nameMaxLength || NAME_MAX;
    for (const skill of skills) {
      if (skill.yamlError || !skill.name) continue;
      if (!pattern.test(skill.name)) {
        out.push(
          f({
            skill,
            line: skill.keyLines['name'] ?? 1,
            message: `name ${skill.name} violates pattern ${contract.frontmatter.namePattern}`,
          }),
        );
        continue;
      }
      if (skill.name.length > max) {
        out.push(
          f({
            skill,
            line: skill.keyLines['name'] ?? 1,
            message: `name ${skill.name} is ${skill.name.length} chars; max is ${max}`,
          }),
        );
      }
    }
    return out;
  },
};

export const descriptionTooLong: Check = {
  id: 'description-too-long',
  tier: 1,
  run: ({ skills, contract }) => {
    const out: Finding[] = [];
    const f = make('description-too-long', 1);
    const max = contract.frontmatter.descriptionMaxLength;
    for (const skill of skills) {
      if (skill.yamlError) continue;
      const len = descriptionOf(skill).length;
      if (len <= max) continue;
      out.push(
        f({
          skill,
          line: skill.keyLines['description'] ?? 1,
          message: `description is ${len} chars; max is ${max}`,
        }),
      );
    }
    return out;
  },
};

export const descriptionCapped: Check = {
  id: 'description-capped',
  tier: 1,
  run: ({ skills, budget }) => {
    const out: Finding[] = [];
    const f = make('description-capped', 1);
    const cap = budget.perEntryCapChars;
    for (const skill of skills) {
      if (skill.yamlError) continue;
      const len = listingText(skill).length;
      if (len <= cap) continue;
      out.push(
        f({
          skill,
          line: skill.keyLines['description'] ?? 1,
          message: `${len - cap} chars will never reach the model (cap ${cap.toLocaleString('en-US')})`,
        }),
      );
    }
    return out;
  },
};

export const budgetExceeded: Check = {
  id: 'budget-exceeded',
  tier: 1,
  run: ({ budget, skills }) => {
    if (budget.effectiveChars <= budget.limitChars) return [];
    const over = budget.effectiveChars - budget.limitChars;
    return [
      make('budget-exceeded', 1)({
        skill: null,
        message:
          `${budget.effectiveChars} / ${budget.limitChars} effective chars ` +
          `(${budget.percentUsed.toFixed(1)}%) — over by ${over}. ` +
          `Names still list, but the host drops descriptions to fit (${skills.length} skills at risk).`,
        fix: {
          kind: 'trim-descriptions',
          confidence: 'likely',
        },
      }),
    ];
  },
};

export const exactNameCollision: Check = {
  id: 'exact-name-collision',
  tier: 1,
  run: ({ skills }) => {
    const out: Finding[] = [];
    const f = make('exact-name-collision', 1);
    const groups = new Map<string, Skill[]>();
    for (const skill of skills) {
      if (skill.yamlError) continue;
      // Plugin skills are namespaced (`plugin:skill`), so two plugins shipping the
      // same name do not shadow each other. Within one namespace they do.
      const key = skill.plugin ? `${skill.plugin}:${displayName(skill)}` : displayName(skill);
      const list = groups.get(key);
      if (list) list.push(skill);
      else groups.set(key, [skill]);
    }
    for (const [name, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (group.length < 2) continue;
      const paths = group.map((s) => `${s.source}:${s.path}`).sort();
      out.push(
        f({
          skill: group[0] ?? null,
          message: `${name} is shadowed: ${group.length} skills resolve to the same command name (${paths.join(', ')})`,
        }),
      );
    }
    return out;
  },
};

export const unknownField: Check = {
  id: 'unknown-field',
  tier: 1,
  run: ({ skills, contract }) => {
    const out: Finding[] = [];
    const f = make('unknown-field', 1);
    const allowed = new Set(contract.frontmatter.allowedFields);
    for (const skill of skills) {
      if (skill.yamlError) continue;
      const unknown = Object.keys(skill.frontmatter).filter((k) => !allowed.has(k));
      if (unknown.length === 0) continue;
      const rejected = unknown.filter((k) => contract.frontmatter.rejectedOnUploadPath.includes(k));
      const fields = unknown.sort().join(', ');
      out.push(
        f({
          skill,
          severity: rejected.length > 0 ? 'error' : 'warning',
          line: skill.keyLines[unknown[0] ?? ''] ?? 1,
          message:
            rejected.length > 0
              ? `${rejected.join(', ')} is rejected on claude.ai upload paths; other unknown fields: ${fields}`
              : `${fields} ${unknown.length === 1 ? 'is' : 'are'} not part of the host contract and will be ignored`,
          fix: { kind: 'remove-frontmatter-field', confidence: 'heuristic' },
        }),
      );
    }
    return out;
  },
};

export const requiredFieldMissing: Check = {
  id: 'required-field-missing',
  tier: 1,
  run: ({ skills, contract }) => {
    const required = contract.frontmatter.required;
    if (required.length === 0) return [];
    const out: Finding[] = [];
    const f = make('required-field-missing', 1);
    for (const skill of skills) {
      if (skill.yamlError) continue;
      for (const field of required) {
        if (Object.prototype.hasOwnProperty.call(skill.frontmatter, field)) continue;
        out.push(
          f({
            skill,
            line: 1,
            message: `${field} is required by ${contract.host} ${contract.versionRange}`,
          }),
        );
      }
    }
    return out;
  },
};

export const TIER1_CHECKS: readonly Check[] = [
  yamlInvalid,
  missingName,
  missingDescription,
  nameFolderMismatch,
  nameInvalid,
  descriptionTooLong,
  descriptionCapped,
  budgetExceeded,
  exactNameCollision,
  unknownField,
  requiredFieldMissing,
];
