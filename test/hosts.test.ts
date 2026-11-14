/**
 * Phase 4c: multi-host contracts. Fixtures build a cursor/codex/gemini-cli
 * corpus in a temp home+project and drive both the library functions and the
 * real CLI (`node dist/cli.js --host <host>`) so the --host cascade from CLI
 * flag through contract loader to discovery is covered end to end.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runChecks } from '../src/checks/index.js';
import { loadContract } from '../src/contracts/loader.js';
import { discoverSkills } from '../src/discovery/walk.js';

let baseDir: string;
let homeDir: string;
let projectDir: string;

beforeAll(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'skill-diag-hosts-'));
  homeDir = join(baseDir, 'home');
  projectDir = join(baseDir, 'project');

  const put = (file: string, text: string): void => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, 'utf8');
  };

  // Cursor: clean rule, nested rule, missing description, unknown field, user rule.
  put(
    join(projectDir, '.cursor', 'rules', 'always.mdc'),
    '---\ndescription: Formats SQL migrations and checks them against the team style guide\nglobs: "**/*.sql"\nalwaysApply: false\n---\n\nBody.\n',
  );
  put(
    join(projectDir, '.cursor', 'rules', 'nested', 'deep-rule.mdc'),
    '---\ndescription: Reviews database indexes for missing composite keys and hot columns\n---\n\nBody.\n',
  );
  put(
    join(projectDir, '.cursor', 'rules', 'no-desc.mdc'),
    '---\nglobs: "**/*.test.ts"\n---\n\nBody.\n',
  );
  put(
    join(projectDir, '.cursor', 'rules', 'extra-field.mdc'),
    '---\ndescription: Watches the deploy pipeline and reports failed stages with logs\nmodel: sonnet\n---\n\nBody.\n',
  );
  put(
    join(homeDir, '.cursor', 'rules', 'user-rule.mdc'),
    '---\ndescription: Reminds about the internal registry mirror before any npm install\n---\n\nBody.\n',
  );

  // Gemini: plain markdown at the root (no frontmatter), one with frontmatter.
  put(join(projectDir, 'GEMINI.md'), '# Project instructions\n\nKeep changes small.\n');
  put(
    join(projectDir, '.gemini', 'GEMINI.md'),
    '---\ndescription: Explains the monorepo layout and where shared types live\n---\n\nBody.\n',
  );
  put(
    join(homeDir, '.gemini', 'GEMINI.md'),
    '---\ndescription: Global Gemini context for the developer environment setup\n---\n\nBody.\n',
  );

  // Codex: same SKILL.md shape as claude.
  put(
    join(homeDir, '.codex', 'skills', 'codex-skill', 'SKILL.md'),
    '---\nname: codex-skill\ndescription: Summarizes failing test output and proposes the smallest fix\n---\n\nBody.\n',
  );
  put(
    join(projectDir, '.codex', 'skills', 'proj-codex', 'SKILL.md'),
    '---\nname: proj-codex\ndescription: Audits dependency updates for breaking changes before applying them\n---\n\nBody.\n',
  );
});

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('loadContract', () => {
  it('loads the cursor contract with cursor fields', () => {
    const c = loadContract('cursor');
    expect(c.host).toBe('cursor');
    expect(c.frontmatter.required).toEqual(['description']);
    expect(c.frontmatter.allowedFields).toEqual(['description', 'globs', 'alwaysApply']);
  });

  it('loads the codex contract with codex roots', () => {
    const c = loadContract('codex');
    expect(c.host).toBe('codex');
    expect(c.skillRoots).toEqual(['~/.codex/skills', '.codex/skills']);
  });

  it('loads the gemini-cli contract', () => {
    const c = loadContract('gemini-cli');
    expect(c.host).toBe('gemini-cli');
    expect(c.frontmatter.required).toEqual(['description']);
  });

  it('defaults to claude-code', () => {
    expect(loadContract().host).toBe('claude-code');
    expect(loadContract('claude-code').host).toBe('claude-code');
  });

  it('throws for an unknown host', () => {
    expect(() => loadContract('bogus')).toThrow(/unsupported host contract: bogus/);
  });
});

describe('multi-host discovery', () => {
  it('finds cursor .mdc rules recursively and names them by filename stem', () => {
    const skills = discoverSkills({ home: homeDir, project: projectDir, host: 'cursor' });
    const names = skills.map((s) => s.name ?? s.folderName).sort();
    expect(names).toEqual(['always', 'deep-rule', 'extra-field', 'no-desc', 'user-rule']);
    expect(skills.find((s) => s.folderName === 'user-rule')?.source).toBe('user');
    expect(skills.find((s) => s.folderName === 'deep-rule')?.source).toBe('project');
  });

  it('finds GEMINI.md in root, .gemini, and home with scope-distinct names', () => {
    const skills = discoverSkills({ home: homeDir, project: projectDir, host: 'gemini-cli' });
    const names = skills.map((s) => s.name ?? s.folderName).sort();
    expect(names).toEqual(['gemini', 'gemini-project', 'gemini-user']);
    expect(skills.find((s) => s.folderName === 'gemini')?.source).toBe('project');
    expect(skills.find((s) => s.folderName === 'gemini-user')?.source).toBe('user');
  });

  it('finds codex SKILL.md under .codex/skills in home and project', () => {
    const skills = discoverSkills({ home: homeDir, project: projectDir, host: 'codex' });
    const names = skills.map((s) => s.name ?? s.folderName).sort();
    expect(names).toEqual(['codex-skill', 'proj-codex']);
  });
});

describe('multi-host checks', () => {
  it('flags a cursor rule missing its required description', () => {
    const contract = loadContract('cursor');
    const skills = discoverSkills({ home: homeDir, project: projectDir, host: 'cursor' });
    const report = runChecks(skills, { contract, commands: [] });
    const finding = report.findings.find(
      (f) => f.checkId === 'required-field-missing' && f.skillName === 'no-desc',
    );
    expect(finding).toBeDefined();
    expect(finding?.message).toContain('description is required by cursor');
  });

  it('flags an unknown cursor frontmatter field', () => {
    const contract = loadContract('cursor');
    const skills = discoverSkills({ home: homeDir, project: projectDir, host: 'cursor' });
    const report = runChecks(skills, { contract, commands: [] });
    const finding = report.findings.find(
      (f) => f.checkId === 'unknown-field' && f.skillName === 'extra-field',
    );
    expect(finding).toBeDefined();
    expect(finding?.message).toContain('model');
  });

  it('flags a frontmatter-less GEMINI.md as missing its required description', () => {
    const contract = loadContract('gemini-cli');
    const skills = discoverSkills({ home: homeDir, project: projectDir, host: 'gemini-cli' });
    const report = runChecks(skills, { contract, commands: [] });
    const gemini = report.findings.filter((f) => f.skillName === 'gemini');
    expect(gemini.some((f) => f.checkId === 'missing-description')).toBe(true);
    expect(gemini.some((f) => f.checkId === 'required-field-missing')).toBe(true);
  });
});

const hasCli = existsSync('dist/cli.js');

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, ['dist/cli.js', ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe.skipIf(!hasCli)('multi-host CLI', () => {
  it('--host cursor discovers and validates .mdc rules end to end', () => {
    const result = run(['--host', 'cursor', '--json', '--home', homeDir, '-p', projectDir]);
    const json = JSON.parse(result.stdout) as {
      summary: { skills: number };
      findings: { checkId: string; skill: string }[];
    };
    expect(json.summary.skills).toBe(5);
    expect(
      json.findings.some((f) => f.checkId === 'required-field-missing' && f.skill === 'no-desc'),
    ).toBe(true);
    expect(result.status).toBe(1); // an error-severity finding fails the gate
  });

  it('--host gemini-cli discovers GEMINI.md end to end', () => {
    const result = run(['--host', 'gemini-cli', '--json', '--home', homeDir, '-p', projectDir]);
    const json = JSON.parse(result.stdout) as {
      summary: { skills: number };
      findings: { checkId: string; skill: string }[];
    };
    expect(json.summary.skills).toBe(3);
    expect(
      json.findings.some((f) => f.checkId === 'missing-description' && f.skill === 'gemini'),
    ).toBe(true);
    expect(result.status).toBe(1);
  });

  it('--host codex finds SKILL.md and passes a clean corpus', () => {
    const result = run(['--host', 'codex', '--json', '--home', homeDir, '-p', projectDir]);
    const json = JSON.parse(result.stdout) as { summary: { skills: number; errors: number } };
    expect(json.summary.skills).toBe(2);
    expect(json.summary.errors).toBe(0);
    expect(result.status).toBe(0);
  });

  it('rejects an unknown host with a usage error', () => {
    const result = run(['--host', 'bogus', '--home', homeDir, '-p', projectDir]);
    expect(result.status).toBe(4);
    expect(result.stderr).toContain('unsupported host contract: bogus');
  });
});
