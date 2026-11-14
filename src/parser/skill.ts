/**
 * Strict parser (Layer 1). Mimics the host loader rather than merely validating
 * YAML: tabs in indentation and duplicate keys are errors here because the host
 * fails on them, even though a permissive YAML reader would accept them.
 *
 * Line numbers are reported against the file, not against the frontmatter block,
 * so a finding points at a line an editor can jump to.
 */

import { parseDocument } from 'yaml';
import type { Skill, SkillSource, YamlFailure } from '../types.js';

export interface ParseInput {
  path: string;
  text: string;
  source: SkillSource;
  plugin?: string;
  /**
   * Phase 4c: name override for flat-file hosts (cursor `.mdc`, GEMINI.md)
   * where the identity comes from the filename or scope, not a parent
   * directory. Absent → the directory two segments up, as for SKILL.md.
   */
  folderName?: string;
}

const KEY_LINE = /^([A-Za-z0-9_.-]+)\s*:/;
const TAB_INDENT = /^[ \t]*\t/;

function stripAnsi(s: string): string {
  // The yaml package can emit colour codes in error messages.
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

export function parseSkillFile(input: ParseInput): Skill {
  const lines = input.text.split(/\r?\n/);
  const folderName = input.folderName ?? input.path.split(/[\\/]/).slice(-2)[0] ?? '';

  let frontmatterText = '';
  let bodyStart = 0;
  let fmStartLine = 2; // line 1 is the opening `---`

  if (lines[0]?.trim() === '---') {
    let end = -1;
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i]?.trim() === '---') {
        end = i;
        break;
      }
    }
    if (end === -1) {
      return {
        name: null,
        folderName,
        path: input.path,
        source: input.source,
        ...(input.plugin ? { plugin: input.plugin } : {}),
        frontmatter: {},
        body: lines.slice(1).join('\n'),
        yamlError: { line: 1, column: 1, message: 'frontmatter is never closed with `---`' },
        bodyStartLine: 2,
        keyLines: {},
      };
    }
    frontmatterText = lines.slice(1, end).join('\n');
    bodyStart = end + 1;
  } else {
    // No frontmatter at all: not a YAML error, just an empty contract. The
    // missing-name / missing-description checks are what should fire here.
    bodyStart = 0;
    frontmatterText = '';
  }

  const keyLines: Record<string, number> = {};
  const fmLines = frontmatterText.length ? frontmatterText.split('\n') : [];
  fmLines.forEach((line, i) => {
    const m = KEY_LINE.exec(line);
    if (m?.[1]) keyLines[m[1]] = fmStartLine + i;
  });

  // Tabs are a load-breaker for the host's frontmatter reader.
  for (let i = 0; i < fmLines.length; i += 1) {
    if (TAB_INDENT.test(fmLines[i] ?? '')) {
      const failure: YamlFailure = {
        line: fmStartLine + i,
        column: 1,
        message: 'tab character in indentation — the host loader rejects tabs',
      };
      return {
        name: null,
        folderName,
        path: input.path,
        source: input.source,
        ...(input.plugin ? { plugin: input.plugin } : {}),
        frontmatter: {},
        body: lines.slice(bodyStart).join('\n'),
        yamlError: failure,
        bodyStartLine: bodyStart + 1,
        keyLines,
      };
    }
  }

  let data: unknown = {};
  let yamlError: YamlFailure | undefined;

  if (frontmatterText.trim().length > 0) {
    const doc = parseDocument(frontmatterText, { uniqueKeys: true });
    if (doc.errors.length > 0) {
      const err = doc.errors[0];
      const pos = err?.linePos?.[0];
      yamlError = {
        line: pos ? fmStartLine + pos.line - 1 : fmStartLine,
        column: pos?.col ?? 1,
        message: stripAnsi(err?.message ?? 'invalid YAML'),
      };
    } else {
      data = doc.toJS() ?? {};
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        yamlError = {
          line: fmStartLine,
          column: 1,
          message: 'frontmatter must be a mapping of keys to values',
        };
        data = {};
      }
    }
  }

  const fm = (yamlError ? {} : (data as Record<string, unknown>)) ?? {};
  const rawName = fm['name'];
  const name = typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : null;

  const skill: Skill = {
    name,
    folderName,
    path: input.path,
    source: input.source,
    ...(input.plugin ? { plugin: input.plugin } : {}),
    frontmatter: fm,
    body: lines.slice(bodyStart).join('\n'),
    ...(yamlError ? { yamlError } : {}),
    bodyStartLine: bodyStart + 1,
    keyLines,
  };
  return skill;
}

/** `description + when_to_use` — one string for every listing-budget purpose. */
export function listingText(skill: Skill): string {
  const d = skill.frontmatter['description'];
  const w = skill.frontmatter['when_to_use'];
  return `${typeof d === 'string' ? d : ''}${typeof w === 'string' ? w : ''}`;
}

export function descriptionOf(skill: Skill): string {
  const d = skill.frontmatter['description'];
  return typeof d === 'string' ? d : '';
}
