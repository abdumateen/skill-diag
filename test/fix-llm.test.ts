/**
 * Phase 4d: `--fix` (mechanical repairs + printed diff) and `--llm` (local-CLI
 * semantic grading). `--fix` mutates its fixtures, so every unit test builds
 * its own throwaway corpus; the CLI tests share one corpus in declaration
 * order (the --fix test runs first and mutates it on purpose).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runChecks } from '../src/checks/index.js';
import { loadContract } from '../src/contracts/loader.js';
import { discoverSkills } from '../src/discovery/walk.js';
import { applyMechanicalFixes } from '../src/fix.js';
import { gradeDescriptions, parseVerdict } from '../src/llm.js';

function makeCorpus(): {
  base: string;
  home: string;
  project: string;
  put: (file: string, text: string) => void;
} {
  const base = mkdtempSync(join(tmpdir(), 'skill-diag-fix-'));
  const home = join(base, 'home');
  const project = join(base, 'project');
  const put = (file: string, text: string): void => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, 'utf8');
  };
  return { base, home, project, put };
}

describe('applyMechanicalFixes', () => {
  it('aligns the frontmatter name with the folder when name-folder-mismatch fires', () => {
    const c = makeCorpus();
    const file = join(c.project, '.claude', 'skills', 'deploy', 'SKILL.md');
    c.put(
      file,
      '---\nname: deploy-checklist\ndescription: Ships the service and verifies the health endpoint\n---\n\nBody.\n',
    );
    const contract = loadContract();
    const skills = discoverSkills({ home: c.home, project: c.project });
    const report = runChecks(skills, { contract, commands: [] });
    const out: string[] = [];
    const run = applyMechanicalFixes(skills, {
      findings: report.findings,
      contract,
      capChars: report.budget.perEntryCapChars,
      write: (t) => out.push(t),
    });
    expect(run.applied).toHaveLength(1);
    expect(run.applied[0]?.kind).toBe('name-field');
    expect(readFileSync(file, 'utf8')).toContain('name: deploy\n');
    expect(out.join('')).toContain('- name: deploy-checklist');
    expect(out.join('')).toContain('+ name: deploy');
    const after = runChecks(discoverSkills({ home: c.home, project: c.project }), {
      contract,
      commands: [],
    });
    expect(after.findings.some((f) => f.checkId === 'name-folder-mismatch')).toBe(false);
    rmSync(c.base, { recursive: true, force: true });
  });

  it('trims a description that busts the listing cap and keeps the rest of the file intact', () => {
    const c = makeCorpus();
    const file = join(c.project, '.claude', 'skills', 'long-desc', 'SKILL.md');
    c.put(file, `---\nname: long-desc\ndescription: ${'x'.repeat(2000)}\n---\n\nBody line.\n`);
    const contract = loadContract();
    const skills = discoverSkills({ home: c.home, project: c.project });
    const report = runChecks(skills, { contract, commands: [] });
    const out: string[] = [];
    const run = applyMechanicalFixes(skills, {
      findings: report.findings,
      contract,
      capChars: report.budget.perEntryCapChars,
      write: (t) => out.push(t),
    });
    expect(run.applied.some((f) => f.kind === 'trim-description')).toBe(true);
    const fixed = readFileSync(file, 'utf8');
    const m = /^description: (.*)$/m.exec(fixed);
    const parsed = JSON.parse(m?.[1] ?? '""') as string;
    expect(parsed.length).toBe(1024); // min(cap 1536, descriptionMaxLength 1024)
    expect(fixed.startsWith('---\nname: long-desc\n')).toBe(true);
    expect(fixed.endsWith('\n---\n\nBody line.\n')).toBe(true);
    rmSync(c.base, { recursive: true, force: true });
  });

  it('never fixes plugin-owned files', () => {
    const c = makeCorpus();
    const file = join(
      c.home,
      '.claude',
      'plugins',
      'cache',
      'mkt',
      'plug',
      '1.0',
      'skills',
      'plugskill',
      'SKILL.md',
    );
    c.put(
      file,
      '---\nname: wrong-name\ndescription: Watches the queue and restarts stuck workers automatically\n---\n\nBody.\n',
    );
    const contract = loadContract();
    const skills = discoverSkills({ home: c.home, project: c.project });
    const report = runChecks(skills, { contract, commands: [] });
    const run = applyMechanicalFixes(skills, {
      findings: report.findings,
      contract,
      capChars: report.budget.perEntryCapChars,
      write: () => {},
    });
    expect(run.applied).toHaveLength(0);
    expect(run.skipped.some((s) => s.reason.includes('plugin-owned'))).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('name: wrong-name');
    rmSync(c.base, { recursive: true, force: true });
  });

  it('leaves block-scalar descriptions alone instead of guessing at their extent', () => {
    const c = makeCorpus();
    const file = join(c.project, '.claude', 'skills', 'blocky', 'SKILL.md');
    c.put(file, `---\nname: blocky\ndescription: >\n  ${'y'.repeat(2000)}\n---\n\nBody.\n`);
    const contract = loadContract();
    const skills = discoverSkills({ home: c.home, project: c.project });
    const report = runChecks(skills, { contract, commands: [] });
    const run = applyMechanicalFixes(skills, {
      findings: report.findings,
      contract,
      capChars: report.budget.perEntryCapChars,
      write: () => {},
    });
    expect(run.applied).toHaveLength(0);
    expect(run.skipped.some((s) => s.reason.includes('single-line'))).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('description: >');
    rmSync(c.base, { recursive: true, force: true });
  });

  it('never invents content: a missing description is reported, not fabricated', () => {
    const c = makeCorpus();
    const file = join(c.project, '.claude', 'skills', 'no-desc', 'SKILL.md');
    c.put(file, '---\nname: no-desc\n---\n\nBody.\n');
    const contract = loadContract();
    const skills = discoverSkills({ home: c.home, project: c.project });
    const report = runChecks(skills, { contract, commands: [] });
    const run = applyMechanicalFixes(skills, {
      findings: report.findings,
      contract,
      capChars: report.budget.perEntryCapChars,
      write: () => {},
    });
    expect(run.applied).toHaveLength(0);
    expect(report.findings.some((f) => f.checkId === 'missing-description')).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('---\nname: no-desc\n---\n\nBody.\n');
    rmSync(c.base, { recursive: true, force: true });
  });
});

describe('llm grading', () => {
  it('reads PASS, FAIL with a reason, and rejects chatter', () => {
    expect(parseVerdict('PASS')?.pass).toBe(true);
    expect(parseVerdict('FAIL: reads like a changelog')).toEqual({
      pass: false,
      reason: 'reads like a changelog',
    });
    expect(parseVerdict('FAIL')).toEqual({
      pass: false,
      reason: 'description reads as a step-by-step summary rather than a trigger clause',
    });
    expect(parseVerdict('The description is fine')).toBeNull();
  });

  it('turns a FAIL verdict into an advisory info finding', () => {
    const c = makeCorpus();
    const file = join(c.project, '.claude', 'skills', 'changelog', 'SKILL.md');
    c.put(
      file,
      '---\nname: changelog\ndescription: Reads the changelog, groups entries by type, and drafts release notes\n---\n\nBody.\n',
    );
    const skills = discoverSkills({ home: c.home, project: c.project });
    const grade = gradeDescriptions(skills, {
      runner: () => 'FAIL: narrates steps instead of saying when to use it',
    });
    expect(grade.available).toBe(true);
    expect(grade.findings).toHaveLength(1);
    expect(grade.findings[0]?.checkId).toBe('llm-description');
    expect(grade.findings[0]?.severity).toBe('info');
    expect(grade.findings[0]?.message).toContain('narrates steps');
    rmSync(c.base, { recursive: true, force: true });
  });

  it('degrades to unavailable when no local CLI exists', () => {
    const c = makeCorpus();
    const file = join(c.project, '.claude', 'skills', 'plain', 'SKILL.md');
    c.put(
      file,
      '---\nname: plain\ndescription: Formats ledger entries before the month-end close\n---\n\nBody.\n',
    );
    const skills = discoverSkills({ home: c.home, project: c.project });
    const enoent = (): string => {
      const e = new Error('spawn ENOENT') as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      throw e;
    };
    const grade = gradeDescriptions(skills, { runner: enoent });
    expect(grade.available).toBe(false);
    expect(grade.findings).toHaveLength(0);
    rmSync(c.base, { recursive: true, force: true });
  });
});

const hasCli = existsSync('dist/cli.js');

function run(
  args: string[],
  env?: NodeJS.ProcessEnv,
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, ['dist/cli.js', ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe.skipIf(!hasCli)('fix/llm CLI', () => {
  let base: string;
  let homeDir: string;
  let projectDir: string;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'skill-diag-fixcli-'));
    homeDir = join(base, 'home');
    projectDir = join(base, 'project');
    const put = (file: string, text: string): void => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text, 'utf8');
    };
    put(
      join(projectDir, '.claude', 'skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy-checklist\ndescription: Ships the service and verifies the health endpoint after each deploy\n---\n\nBody.\n',
    );
    put(
      join(projectDir, '.claude', 'skills', 'no-desc', 'SKILL.md'),
      '---\nname: no-desc\n---\n\nBody.\n',
    );
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('--fix patches the mismatch, prints the diff on stderr under --json, and re-checks', () => {
    const result = run(['--fix', '--json', '--home', homeDir, '-p', projectDir]);
    const json = JSON.parse(result.stdout) as {
      summary: { skills: number };
      findings: { checkId: string }[];
    };
    expect(json.summary.skills).toBe(2);
    expect(json.findings.some((f) => f.checkId === 'name-folder-mismatch')).toBe(false);
    // Semantic issues are never auto-fixed: the missing description survives.
    expect(json.findings.some((f) => f.checkId === 'missing-description')).toBe(true);
    expect(result.stderr).toContain('+ name: deploy');
    expect(
      readFileSync(join(projectDir, '.claude', 'skills', 'deploy', 'SKILL.md'), 'utf8'),
    ).toContain('name: deploy\n');
    expect(result.status).toBe(1); // the surviving semantic error still gates
  });

  it('--llm without a local CLI warns and leaves the exit code alone', () => {
    const before = run(['--json', '--home', homeDir, '-p', projectDir]);
    const after = run(['--llm', '--json', '--home', homeDir, '-p', projectDir], {
      SKILL_DIAG_LLM_BIN: 'skill-diag-no-such-cli',
    });
    expect(JSON.parse(after.stdout)).toBeDefined();
    expect(after.stderr).toContain('no local grading CLI found');
    expect(after.status).toBe(before.status);
  });
});
