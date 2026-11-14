/**
 * Phase 4a: OTEL ingestion, the static–runtime join, and the runtime surfaces.
 *
 * The fixture is generated, not committed: 200 session records (the
 * zero-activation denominator), 47 skill-b activations, 3 skill-c activations
 * through the fallback extraction path, one non-skill record, one malformed
 * line. skill-a never fires; it shares a description with skill-b, so the
 * join should flag it as a trigger-theft suspect with skill-b as the thief.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSkillFile } from '../src/parser/skill.js';
import {
  analyzeRuntimeJoin,
  ingestOtelFile,
  loadRuntimeStore,
  MIN_SESSIONS,
  parseOtelRecord,
} from '../src/model/runtime.js';
import type { Skill } from '../src/types.js';

const SKILL_EVENT = 'claude_code.skill_activated';
const SHARED =
  'Reviews pull requests for correctness and security then writes a summary of the findings for the maintainer team';
const DISTINCT =
  'Manages database migrations and schema evolution for the application deployment pipeline across environments';

let baseDir: string;
let fixturePath: string;
let storePath: string;
let homeDir: string;
let projectDir: string;

function skill(name: string, description: string): Skill {
  return parseSkillFile({
    path: `/corpus/skills/${name}/SKILL.md`,
    text: `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\nBody.\n`,
    source: 'user',
  });
}

function staticSkills(): Skill[] {
  return [skill('skill-a', SHARED), skill('skill-b', SHARED), skill('skill-c', DISTINCT)];
}

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-diag-runtime-'));
  baseDir = dir;
  fixturePath = join(dir, 'activations.jsonl');
  storePath = join(dir, 'runtime.jsonl');

  const lines: string[] = [];
  for (let i = 1; i <= 200; i += 1) {
    const id = `s${String(i).padStart(3, '0')}`;
    lines.push(JSON.stringify({ ts: 1731600000000 + i, attributes: { 'session.id': id } }));
  }
  for (let i = 1; i <= 47; i += 1) {
    const id = `s${String(i).padStart(3, '0')}`;
    lines.push(
      JSON.stringify({
        ts: 1731600000000 + i,
        attributes: {
          'event.name': SKILL_EVENT,
          'session.id': id,
          'skill.name': 'skill-b',
          'skill.source': 'user',
          invocation_trigger: 'user',
        },
      }),
    );
  }
  for (let i = 1; i <= 3; i += 1) {
    const id = `s${String(i).padStart(3, '0')}`;
    lines.push(JSON.stringify({ body: SKILL_EVENT, session_id: id, skill_name: 'skill-c' }));
  }
  lines.push(JSON.stringify({ attributes: { 'event.name': 'claude_code.tool_usage', 'session.id': 's050' } }));
  lines.push('{not json');
  writeFileSync(fixturePath, `${lines.join('\n')}\n`, 'utf8');

  homeDir = join(dir, 'home');
  projectDir = join(dir, 'project');
  mkdirSync(projectDir, { recursive: true });
  for (const [name, description] of [
    ['skill-a', SHARED],
    ['skill-b', SHARED],
    ['skill-c', DISTINCT],
  ] as const) {
    const file = join(homeDir, '.claude', 'skills', name, 'SKILL.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\nBody.\n`,
      'utf8',
    );
  }
});

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('parseOtelRecord', () => {
  it('extracts skill fields from dotted attributes', () => {
    const res = parseOtelRecord({
      ts: 1731600000001,
      attributes: {
        'event.name': SKILL_EVENT,
        'session.id': 's001',
        'skill.name': 'skill-b',
        'skill.source': 'user',
        invocation_trigger: 'user',
      },
    });
    expect(res).toEqual({
      session: 's001',
      skill: { name: 'skill-b', source: 'user', trigger: 'user' },
    });
  });

  it('falls back to top-level fields when attributes are absent', () => {
    const res = parseOtelRecord({
      body: SKILL_EVENT,
      session_id: 's002',
      skill_name: 'skill-c',
    });
    expect(res).toEqual({
      session: 's002',
      skill: { name: 'skill-c', source: null, trigger: null },
    });
  });

  it('reads a nested skill object', () => {
    const res = parseOtelRecord({
      attributes: { 'event.name': SKILL_EVENT },
      skill: { name: 'skill-x', source: 'plugin', invocation_trigger: 'auto' },
    });
    expect(res).toEqual({
      session: null,
      skill: { name: 'skill-x', source: 'plugin', trigger: 'auto' },
    });
  });

  it('returns the session of a non-skill record without a skill', () => {
    const res = parseOtelRecord({
      attributes: { 'event.name': 'claude_code.tool_usage', 'session.id': 's050' },
    });
    expect(res).toEqual({ session: 's050', skill: null });
  });

  it('rejects non-object records', () => {
    expect(parseOtelRecord('a string')).toBeNull();
    expect(parseOtelRecord([1, 2])).toBeNull();
    expect(parseOtelRecord(null)).toBeNull();
  });

  it('keeps the session when a skill event carries no skill name', () => {
    const res = parseOtelRecord({
      attributes: { 'event.name': SKILL_EVENT, 'session.id': 's009' },
    });
    expect(res).toEqual({ session: 's009', skill: null });
  });
});

describe('ingestOtelFile', () => {
  it('ingests the 200-session fixture into the store', () => {
    const result = ingestOtelFile(fixturePath, storePath);
    expect(result).toEqual({ events: 50, sessions: 200, skipped: 1 });
    const store = loadRuntimeStore(storePath);
    expect(store.sessions).toHaveLength(200);
    expect(store.activations).toHaveLength(50);
  });

  it('throws on a missing file', () => {
    expect(() => ingestOtelFile(join(baseDir, 'missing.jsonl'), storePath)).toThrow();
  });

  it('keeps counts stable when the same file is ingested twice', () => {
    ingestOtelFile(fixturePath, storePath);
    const store = loadRuntimeStore(storePath);
    expect(store.activations).toHaveLength(50);
    expect(store.sessions).toHaveLength(200);
  });
});

describe('analyzeRuntimeJoin', () => {
  it('flags a zero-activation skill at 200 sessions', () => {
    const res = analyzeRuntimeJoin(staticSkills(), loadRuntimeStore(storePath));
    expect(res.sessions).toBe(200);
    expect(res.zeroActivation).toEqual(['skill-a']);
    expect(res.skills.find((row) => row.name === 'skill-a')?.activations).toBe(0);
  });

  it('names the firing neighbor as the trigger-theft suspect', () => {
    const res = analyzeRuntimeJoin(staticSkills(), loadRuntimeStore(storePath));
    const row = res.skills.find((candidate) => candidate.name === 'skill-a');
    expect(row?.theftSuspect).toBe(true);
    expect(row?.thiefNeighbor).toEqual({ name: 'skill-b', activations: 47 });
    expect(res.theftSuspects).toEqual(['skill-a']);
  });

  it('does not flag the firing skill itself', () => {
    const res = analyzeRuntimeJoin(staticSkills(), loadRuntimeStore(storePath));
    const row = res.skills.find((candidate) => candidate.name === 'skill-b');
    expect(row?.activations).toBe(47);
    expect(row?.zeroActivation).toBe(false);
    expect(row?.theftSuspect).toBe(false);
  });

  it('withholds zero-activation flags below the session gate', () => {
    const small = join(baseDir, 'small.jsonl');
    const lines: string[] = [];
    for (let i = 1; i <= MIN_SESSIONS - 1; i += 1) {
      lines.push(JSON.stringify({ kind: 'session', id: `t${i}` }));
    }
    writeFileSync(small, `${lines.join('\n')}\n`, 'utf8');
    const res = analyzeRuntimeJoin(staticSkills(), loadRuntimeStore(small));
    expect(res.sessions).toBe(MIN_SESSIONS - 1);
    expect(res.zeroActivation).toEqual([]);
  });

  it('flags zero activation at exactly the session gate', () => {
    const gate = join(baseDir, 'gate.jsonl');
    const lines: string[] = [
      JSON.stringify({ kind: 'session', id: 'g1' }),
      JSON.stringify({ kind: 'activation', name: 'skill-b', session: 'g1', ts: 1 }),
    ];
    for (let i = 2; i <= MIN_SESSIONS; i += 1) {
      lines.push(JSON.stringify({ kind: 'session', id: `g${i}` }));
    }
    writeFileSync(gate, `${lines.join('\n')}\n`, 'utf8');
    const res = analyzeRuntimeJoin(staticSkills(), loadRuntimeStore(gate));
    expect(res.sessions).toBe(MIN_SESSIONS);
    expect(res.zeroActivation).toEqual(['skill-a', 'skill-c']);
    expect(res.theftSuspects).toEqual(['skill-a']);
  });

  it('ranks top firing skills by activations', () => {
    const res = analyzeRuntimeJoin(staticSkills(), loadRuntimeStore(storePath));
    expect(res.topFiring[0]).toEqual({ name: 'skill-b', activations: 47 });
    expect(res.topFiring[1]).toEqual({ name: 'skill-c', activations: 3 });
  });

  it('keeps runtime-only skills out of the per-skill rows', () => {
    const ghost = join(baseDir, 'ghost.jsonl');
    const lines: string[] = [];
    for (let i = 1; i <= 25; i += 1) {
      lines.push(JSON.stringify({ kind: 'session', id: `h${i}` }));
    }
    lines.push(JSON.stringify({ kind: 'activation', name: 'ghost-skill', session: 'h1', ts: 1 }));
    writeFileSync(ghost, `${lines.join('\n')}\n`, 'utf8');
    const res = analyzeRuntimeJoin(staticSkills(), loadRuntimeStore(ghost));
    expect(res.observedSkills).toContain('ghost-skill');
    expect(res.topFiring.map((entry) => entry.name)).toContain('ghost-skill');
    expect(res.skills.map((row) => row.name)).not.toContain('ghost-skill');
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

describe.skipIf(!hasCli)('runtime CLI', () => {
  it('ingest prints counts and exits 0', () => {
    const cliStore = join(baseDir, 'cli-store.jsonl');
    const result = run([
      'runtime', 'ingest', '--otel', fixturePath, '--store', cliStore,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ingested 50 activations across 200 sessions');
    expect(result.stdout).toContain('1 malformed line skipped');
  });

  it('report --json identifies the trigger-theft suspect', () => {
    const result = run([
      'runtime', 'report', '--json', '--home', homeDir, '-p', projectDir, '--store', storePath,
    ]);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as {
      runtime: {
        sessions: number;
        zeroActivation: string[];
        theftSuspects: string[];
        topFiring: { name: string; activations: number }[];
      };
    };
    expect(json.runtime.sessions).toBe(200);
    expect(json.runtime.zeroActivation).toEqual(['skill-a']);
    expect(json.runtime.theftSuspects).toEqual(['skill-a']);
    expect(json.runtime.topFiring[0]).toEqual({ name: 'skill-b', activations: 47 });
  });

  it('report human output names the suspect and the thief', () => {
    const result = run([
      'runtime', 'report', '--home', homeDir, '-p', projectDir, '--store', storePath,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('zero-activation  skill-a');
    expect(result.stdout).toContain('trigger-theft-suspect  skill-a');
    expect(result.stdout).toContain('skill-b fired 47 times');
  });

  it('routing --why surfaces runtime evidence', () => {
    const result = run([
      'routing', '--why', 'skill-a', '--home', homeDir, '-p', projectDir, '--store', storePath,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('runtime activations');
    expect(result.stdout).toContain('0 in 200 sessions');
    expect(result.stdout).toContain('skill-b (47 activations)');
  });

  it('main --why surfaces runtime evidence', () => {
    const result = run([
      '--why', 'skill-a', '--home', homeDir, '-p', projectDir, '--store', storePath,
    ]);
    expect(result.stdout).toContain('fired 0 times in 200 sessions');
    expect(result.stdout).toContain('closest neighbor skill-b fired 47 times');
  });

  it('ingest without --otel is a usage error', () => {
    const result = run(['runtime', 'ingest', '--store', join(baseDir, 'x.jsonl')]);
    expect(result.status).toBe(3);
  });
});
