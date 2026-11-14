/**
 * Phase 4d: `--fix` — unambiguous mechanical repairs only.
 *
 * A fix runs only when the corresponding Tier 1 check fired, so the fix
 * conditions and the report can never disagree. Two repairs qualify:
 *
 *  - `name-folder-mismatch`: the check's own fix metadata points at the
 *    frontmatter `name` field (the folder name is the identity the host keys
 *    on), so the fix rewrites `name:` to the folder name — a one-line file
 *    edit the user can review or revert, never a directory rename.
 *  - `description-capped` / `description-too-long`: the description alone
 *    overruns a deterministic length limit, so it is trimmed to the largest
 *    length that satisfies both limits at once.
 *
 * Everything else (YAML errors, missing fields, collisions, routing) is
 * semantic or ambiguous and is left for a human. Plugin-owned files are never
 * touched: they belong to a plugin checkout, not to the user.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import type { Contract } from './contracts/loader.js';
import { descriptionOf } from './parser/skill.js';
import type { Finding, Skill } from './types.js';

export interface FixResult {
  kind: 'name-field' | 'trim-description';
  path: string;
  before: string;
  after: string;
}

export interface FixSkip {
  path: string;
  reason: string;
}

export interface FixRun {
  applied: FixResult[];
  skipped: FixSkip[];
}

/** Block-scalar indicators and empty values cannot be rewritten line-wise. */
const BLOCK_VALUE = /^(?:[|>][-+0-9]*)?$/;

/**
 * Replace the value of one frontmatter key in place, keeping every other byte
 * of the file (including CRLF endings and the trailing newline) untouched.
 * Returns the before/after lines, or null when the value is not a plain
 * single-line scalar — those are rewritten by hand, not guessed at.
 */
function rewriteValue(
  file: string,
  key: string,
  lineNo: number,
  value: string,
): { before: string; after: string } | null {
  const raw = readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  const idx = lineNo - 1;
  const line = lines[idx];
  if (line === undefined) return null;
  const cr = line.endsWith('\r') ? '\r' : '';
  const body = cr ? line.slice(0, -1) : line;
  const m = /^(\s*)([A-Za-z0-9_.-]+):(\s+)(.*)$/.exec(body);
  if (!m || m[2] !== key) return null;
  const valueText = (m[4] ?? '').trim();
  if (valueText.length === 0 || BLOCK_VALUE.test(valueText)) return null;
  const next = `${m[1]}${m[2]}:${m[3]}${value}`;
  lines[idx] = `${next}${cr}`;
  writeFileSync(file, lines.join('\n'), 'utf8');
  return { before: body, after: next };
}

function preview(text: string): string {
  return text.length > 120 ? `${text.slice(0, 120)}… (${text.length} chars)` : text;
}

export function applyMechanicalFixes(
  skills: readonly Skill[],
  opts: {
    findings: readonly Finding[];
    contract: Contract;
    capChars: number;
    write: (text: string) => void;
  },
): FixRun {
  const pathsOf = (checkId: string): Set<string> =>
    new Set(
      opts.findings
        .filter((f) => f.checkId === checkId && f.skillPath !== null)
        .map((f) => f.skillPath as string),
    );
  const mismatch = pathsOf('name-folder-mismatch');
  const overLong = new Set([...pathsOf('description-capped'), ...pathsOf('description-too-long')]);

  const applied: FixResult[] = [];
  const skipped: FixSkip[] = [];

  for (const skill of skills) {
    const wantsName = mismatch.has(skill.path);
    const wantsTrim = overLong.has(skill.path);
    if (!wantsName && !wantsTrim) continue;
    if (skill.source === 'plugin') {
      skipped.push({ path: skill.path, reason: 'plugin-owned file; fix it in the plugin checkout' });
      continue;
    }
    if (skill.yamlError) continue; // findings never fire on these, but stay safe

    if (wantsName && skill.name !== null && skill.name !== skill.folderName) {
      const lineNo = skill.keyLines['name'];
      const result =
        lineNo === undefined
          ? null
          : rewriteValue(skill.path, 'name', lineNo, skill.folderName);
      if (result === null) {
        skipped.push({ path: skill.path, reason: 'name is not a plain single-line scalar' });
      } else {
        applied.push({ kind: 'name-field', path: skill.path, ...result });
      }
    }

    if (wantsTrim) {
      const desc = descriptionOf(skill);
      const rawWhen = skill.frontmatter['when_to_use'];
      const when = typeof rawWhen === 'string' ? rawWhen : '';
      const max = opts.contract.frontmatter.descriptionMaxLength;
      if (desc.length <= max && desc.length <= opts.capChars) {
        // The description itself fits both limits; the overage comes from
        // when_to_use, and shortening the description for that is not mechanical.
        skipped.push({ path: skill.path, reason: 'when_to_use drives the overage; trim it by hand' });
      } else {
        const target = Math.min(opts.capChars - when.length, max);
        const lineNo = skill.keyLines['description'];
        if (target < 1) {
          skipped.push({ path: skill.path, reason: 'when_to_use alone fills the listing cap; trim it by hand' });
        } else if (lineNo === undefined) {
          skipped.push({ path: skill.path, reason: 'description line not found in frontmatter' });
        } else {
          const result = rewriteValue(skill.path, 'description', lineNo, JSON.stringify(desc.slice(0, target)));
          if (result === null) {
            skipped.push({ path: skill.path, reason: 'description is not a plain single-line scalar' });
          } else {
            applied.push({ kind: 'trim-description', path: skill.path, ...result });
          }
        }
      }
    }
  }

  for (const fix of applied) {
    opts.write(`fix: ${fix.path}\n- ${preview(fix.before)}\n+ ${preview(fix.after)}\n`);
  }
  for (const skip of skipped) {
    opts.write(`skip: ${skip.path} — ${skip.reason}\n`);
  }
  opts.write(
    `${applied.length} fix${applied.length === 1 ? '' : 'es'} applied, ${skipped.length} skipped\n`,
  );
  return { applied, skipped };
}
