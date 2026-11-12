/**
 * `budget --json` and its schema.
 *
 * This exists because the parent/subcommand flag collision meant `budget --json`
 * produced human output for every release up to 2b.1: the flag was declared on
 * both the program and the subcommand, commander gave it to the parent, and the
 * subcommand read an empty options object. A schema test would have caught it;
 * this is that test.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { runChecks } from '../src/checks/index.js';
import { loadContract } from '../src/contracts/loader.js';
import { discoverSkills } from '../src/discovery/walk.js';
import { toJsonReport } from '../src/output/json.js';

const schema = JSON.parse(readFileSync('schema/budget-v1.json', 'utf8')) as object;
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

const CORPUS = join(homedir(), 'AppData/Local/Temp/skill-diag-bl/corpus/home');
const EMPTY = join(homedir(), 'AppData/Local/Temp/skill-diag-emptyhome');

describe('budget JSON contract', () => {
  it('validates a fixture report against schema/budget-v1.json', () => {
    const dir = 'test/fixtures/tier2/routing-health-at-risk/pass';
    const skills = discoverSkills({ home: dir, project: dir });
    const report = runChecks(skills, { contract: loadContract() });
    const json = toJsonReport(report, { version: 'test', strict: false, generatedAt: '1970-01-01T00:00:00.000Z' });
    expect(validate(json)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it('carries the uncalibrated reason rather than a bare zero', () => {
    const skills = discoverSkills({
      home: 'test/fixtures/tier2/routing-health-at-risk/pass',
      project: 'test/fixtures/tier2/routing-health-at-risk/pass',
    });
    const report = runChecks(skills, { contract: loadContract() });
    const json = toJsonReport(report, { version: 'test', strict: false });
    expect(json.budget.overhead.calibrated).toBe(false);
    expect(typeof json.budget.overhead.reason).toBe('string');
  });
});

describe.skipIf(!existsSync('dist/cli.js') || !existsSync(CORPUS))('budget --json on the CLI', () => {
  it('emits JSON, not human output', () => {
    const stdout = execFileSync(process.execPath, ['dist/cli.js', 'budget', '--json', '--home', CORPUS, '-p', EMPTY], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(stdout.trimStart().startsWith('{')).toBe(true);
    const json = JSON.parse(stdout) as { budget: { commandCount: number }; summary: { skills: number } };
    expect(validate(json)).toBe(true);
  });

  it('honours --home instead of silently scanning the real home', () => {
    const stdout = execFileSync(process.execPath, ['dist/cli.js', 'budget', '--json', '--home', EMPTY, '-p', EMPTY], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const json = JSON.parse(stdout) as { summary: { skills: number } };
    // An empty home means nothing found; the real home would report thousands.
    expect(json.summary.skills).toBe(0);
  });
});
