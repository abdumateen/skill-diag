/**
 * `routing` output: the JSON contract, the human render, the config writer, and
 * the built CLI end to end.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
import { afterAll, describe, expect, it } from 'vitest';
import { discoverSkills } from '../src/discovery/walk.js';
import { analyzeRouting } from '../src/model/routing.js';
import { configPath, writeDefaultConfig, DEFAULT_CONFIG_FILE } from '../src/model/config.js';
import { renderRoutingHuman, toRoutingJson } from '../src/output/routing.js';
import { parseSkillFile } from '../src/parser/skill.js';
import type { Skill } from '../src/types.js';

const schema = JSON.parse(readFileSync('schema/routing-v1.json', 'utf8')) as object;
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

const CORPUS = join(homedir(), 'AppData/Local/Temp/skill-diag-bl/corpus/home');
const EMPTY = join(homedir(), 'AppData/Local/Temp/skill-diag-emptyhome');

function duplicateHeavy(): Skill[] {
  const out: Skill[] = [];
  for (let group = 0; group < 5; group += 1) {
    const description = `Group ${group} performs a specific analysis of dataset ${group} and reports the findings for reviewer ${group} in detail`;
    for (let copy = 0; copy < 3; copy += 1) {
      out.push(
        parseSkillFile({
          path: `/corpus/.claude/plugins/plug-${group}/skills/copy-${copy}/SKILL.md`,
          text: `---\nname: copy-${copy}\ndescription: ${JSON.stringify(description)}\n---\n\nBody.\n`,
          source: 'plugin',
          plugin: `plug-${group}`,
        }),
      );
    }
  }
  return out;
}

describe('routing JSON', () => {
  it('validates against schema/routing-v1.json for a duplicate-heavy corpus', () => {
    const json = toRoutingJson(analyzeRouting(duplicateHeavy()), { version: 'test' });
    const ok = validate(json);
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });

  it('renders every headline line in human output', () => {
    const report = analyzeRouting(duplicateHeavy());
    const text = renderRoutingHuman(report, { version: 'test', color: false });
    expect(text).toContain('Routing health');
    expect(text).toContain('naive');
    expect(text).toContain('duplicate-adj');
    expect(text).toContain('break point (0.50)');
    expect(text).toContain('warning threshold (0.60)');
    expect(text).toContain('Top marginal costs');
    expect(text).toContain('Mitigation ladder');
    expect(text).toContain('not-simulated');
  });
});

describe('config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-diag-config-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the documented defaults once and leaves them alone afterwards', () => {
    const first = writeDefaultConfig(dir);
    expect(first.created).toBe(true);
    const written = JSON.parse(readFileSync(configPath(dir), 'utf8')) as typeof DEFAULT_CONFIG_FILE;
    expect(written.routing.r).toBe(0.867);
    expect(written.routing.p).toBe(0.000283);
    expect(written.routing.similarityThreshold).toBe(0.72);
    expect(written.routing.collisionWeight).toBe(1);

    const second = writeDefaultConfig(dir);
    expect(second.created).toBe(false);
  });
});

describe.skipIf(!existsSync('dist/cli.js') || !existsSync(CORPUS))('routing subcommand', () => {
  it('exits 0 and emits schema-valid JSON on the live corpus', () => {
    const stdout = execFileSync(
      process.execPath,
      ['dist/cli.js', 'routing', '--json', '--home', CORPUS, '-p', EMPTY],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
    const json = JSON.parse(stdout) as { routing: { n: number; naiveTop1: number } };
    expect(validate(json)).toBe(true);
    expect(json.routing.n).toBe(1115);
    expect(json.routing.naiveTop1).toBeCloseTo(0.633, 2);
  });
});
