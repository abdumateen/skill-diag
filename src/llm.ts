/**
 * Phase 4d: `--llm` — optional semantic grading of descriptions.
 *
 * skill-diag stays local-first and deterministic, so the semantic layer is
 * opt-in and rides on a CLI the user already has: `claude -p` or, failing
 * that, `codex exec`. No SDK and no network code here — the spawned process
 * is the user's own agent. Verdicts are advisory: they land as `info`
 * findings so they never move the exit code, and a missing CLI degrades to a
 * warning, never an error.
 */

import { execFileSync } from 'node:child_process';
import { descriptionOf } from './parser/skill.js';
import { displayName, type Finding, type Skill } from './types.js';

export const LLM_CHECK_ID = 'llm-description';

const PROMPT = [
  'You are grading one entry in an AI agent skill listing. A router reads the',
  'description to decide when to invoke the skill. A good description is a',
  'trigger clause: it states the situations that should make the agent reach',
  'for this skill ("Use when ..."). A bad description narrates what the skill',
  'does step by step, or gives the router nothing to match against.',
  'Reply with exactly one line: PASS, or FAIL: <short reason>.',
].join('\n');

export type LlmRunner = (bin: string, args: string[], prompt: string) => string;

function defaultRunner(bin: string, args: string[], prompt: string): string {
  return execFileSync(bin, [...args, prompt], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export interface LlmOptions {
  /** Binary override (SKILL_DIAG_LLM_BIN); skips the claude/codex probe. */
  bin?: string;
  /** Injectable for tests; defaults to execFileSync. */
  runner?: LlmRunner;
}

export interface LlmGrade {
  available: boolean;
  bin?: string;
  findings: Finding[];
  graded: number;
  failed: number;
}

export function parseVerdict(text: string): { pass: boolean; reason: string } | null {
  const line = (text.trim().split(/\r?\n/)[0] ?? '').trim();
  if (/^PASS\b/i.test(line)) return { pass: true, reason: '' };
  const m = /^FAIL\b[:\s]*(.*)$/i.exec(line);
  if (m) {
    return {
      pass: false,
      reason:
        m[1]?.trim() ||
        'description reads as a step-by-step summary rather than a trigger clause',
    };
  }
  return null;
}

function findingFor(skill: Skill, reason: string): Finding {
  const line = skill.keyLines['description'];
  return {
    checkId: LLM_CHECK_ID,
    tier: 2,
    severity: 'info',
    skillPath: skill.path,
    skillName: displayName(skill),
    skillSource: skill.source,
    ...(line !== undefined ? { line } : {}),
    message: `LLM grading flagged the description: ${reason}`,
  };
}

export function gradeDescriptions(skills: readonly Skill[], opts: LlmOptions = {}): LlmGrade {
  const runner = opts.runner ?? defaultRunner;
  const targets = skills.filter((s) => !s.yamlError && descriptionOf(s).trim().length > 0);
  const candidates: { bin: string; args: readonly string[] }[] = opts.bin
    ? [{ bin: opts.bin, args: ['-p'] }]
    : [
        { bin: 'claude', args: ['-p'] },
        { bin: 'codex', args: ['exec'] },
      ];

  const findings: Finding[] = [];
  let graded = 0;
  let failed = 0;
  let active: { bin: string; args: readonly string[] } | null = null;

  for (const skill of targets) {
    const prompt = `${PROMPT}\n\nSkill name: ${displayName(skill)}\nDescription: ${descriptionOf(skill)}`;
    let text: string | null = null;
    const order: readonly { bin: string; args: readonly string[] }[] = active
      ? [active]
      : candidates;
    let allMissing = false;
    for (const candidate of order) {
      try {
        text = runner(candidate.bin, [...candidate.args], prompt);
        active = candidate;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !active) {
          allMissing = true;
          continue; // try the next CLI on the probe
        }
        failed += 1; // a real failure (timeout, non-zero exit): skip this skill
        text = null;
        break;
      }
    }
    if (text === null) {
      if (!active && allMissing && order.length === candidates.length) {
        // No grading CLI exists on this machine: degrade gracefully, stop probing.
        return { available: false, findings: [], graded: 0, failed: 0 };
      }
      continue;
    }
    const verdict = parseVerdict(text);
    if (verdict === null) {
      failed += 1; // unparseable answer: skip rather than guess
      continue;
    }
    graded += 1;
    if (!verdict.pass) findings.push(findingFor(skill, verdict.reason));
  }

  return {
    available: active !== null || targets.length === 0,
    ...(active ? { bin: active.bin } : {}),
    findings,
    graded,
    failed,
  };
}
