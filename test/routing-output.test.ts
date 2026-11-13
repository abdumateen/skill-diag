/**
 * `routing` output: the JSON contract, the human render, the config writer, and
 * the built CLI end to end.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(text).toContain('naive P_top1(N)');
    expect(text).toContain('adjusted P_top1(N_eff)');
    expect(text).toContain('break point (0.50)');
    expect(text).toContain('warning threshold (0.60)');
    expect(text).toContain('adjusted headroom');
    expect(text).toContain('naive headroom');
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
  const run = (args: string[]): { stdout: string; code: number } => {
    try {
      const stdout = execFileSync(process.execPath, ['dist/cli.js', 'routing', ...args], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      });
      return { stdout, code: 0 };
    } catch (error) {
      const e = error as { stdout?: string; status?: number };
      return { stdout: e.stdout ?? '', code: e.status ?? -1 };
    }
  };

  it('exits 0 and emits schema-valid JSON on the live corpus', () => {
    const { stdout, code } = run(['--json', '--home', CORPUS, '-p', EMPTY]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as {
      routing: { n: number; naiveTop1: number };
      raw?: { n: number };
      dedupe?: { mode: string };
    };
    expect(validate(json)).toBe(true);
    expect(json.routing.n).toBe(1115);
    expect(json.routing.naiveTop1).toBeCloseTo(0.633, 2);
    expect(json.dedupe?.mode).toBe('enabled-latest');
    expect(json.raw?.n).toBe(1115);
  });

  it('reports both N estimates in JSON and in human output', () => {
    const { stdout } = run(['--json', '--home', CORPUS, '-p', EMPTY]);
    const json = JSON.parse(stdout) as { routing: { n: number; nEff: number }; raw: { n: number } };
    expect(json.routing.n).toBe(1115);
    expect(json.raw.n).toBe(1115);

    const human = run(['--home', CORPUS, '-p', EMPTY, '--no-color']).stdout;
    expect(human).toContain('raw-scan cross-check');
    expect(human).toContain('deduped N=');
    expect(human).toContain('dedupe: enabled-latest');
  });

  it('exits 3 with a message when --why matches nothing', () => {
    const { stdout, code } = run(['--why', 'no-such-skill-anywhere', '--home', CORPUS, '-p', EMPTY]);
    expect(code).toBe(3);
    expect(stdout).toBe('');
  });

  it('explains a single skill in the routing block', () => {
    const { stdout, code } = run(['--why', 'karpathy-guidelines', '--home', CORPUS, '-p', EMPTY, '--no-color']);
    expect(code).toBe(0);
    expect(stdout).toContain('routing survival model');
    expect(stdout).toContain('marginal top-1 contribution');
    expect(stdout).toContain('duplicate cluster size');
    expect(stdout).toContain('routing health contribution');
    expect(stdout).toMatch(/\(.*, (deduped|raw scan)\)/);
  });

  it('exits 2 under --strict only when the estimate is at risk', () => {
    // The corpus is healthy, so --strict must stay 0 there.
    expect(run(['--home', CORPUS, '-p', EMPTY, '--strict', '--quiet']).code).toBe(0);
  });
});

describe.skipIf(!existsSync('dist/cli.js'))('routing exit codes', () => {
  const runCli = (args: string[]): { stdout: string; code: number } => {
    try {
      const stdout = execFileSync(process.execPath, ['dist/cli.js', ...args], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
      return { stdout, code: 0 };
    } catch (error) {
      const e = error as { stdout?: string; status?: number };
      return { stdout: e.stdout ?? '', code: e.status ?? -1 };
    }
  };

  const made: string[] = [];
  afterAll(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A flat plugin corpus of `count` distinct skills — no clusters, no cache. */
  function corpusOf(count: number): string {
    const home = mkdtempSync(join(tmpdir(), 'skill-diag-exit-'));
    made.push(home);
    for (let i = 0; i < count; i += 1) {
      const dir = join(home, '.claude', 'plugins', `plug-${i}`, 'skills', `skill-${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'SKILL.md'),
        `---\nname: skill-${i}\ndescription: Distinct capability number ${i} that handles workflow ${i % 97} with procedure ${i * 7 % 1009}\n---\n\nBody.\n`,
        'utf8',
      );
    }
    return home;
  }

  it('exits 0 at ok, 2 at at-risk under --strict, and 1 at critical', () => {
    const okHome = corpusOf(10);
    expect(runCli(['routing', '--home', okHome, '--quiet']).code).toBe(0);

    const riskHome = corpusOf(1500);
    expect(runCli(['routing', '--home', riskHome, '--quiet']).code).toBe(0);
    expect(runCli(['routing', '--home', riskHome, '--strict', '--quiet']).code).toBe(2);

    const criticalHome = corpusOf(2000);
    expect(runCli(['routing', '--home', criticalHome, '--quiet']).code).toBe(1);
  });

  it('puts the routing findings in the routing JSON, in the main report shape', () => {
    const home = corpusOf(2000);
    const json = JSON.parse(runCli(['routing', '--json', '--home', home]).stdout) as {
      findings: Array<{ checkId: string; tier: number; severity: string; message: string }>;
    };
    expect(validate(json)).toBe(true);
    const critical = json.findings.find((f) => f.checkId === 'routing-health-critical');
    expect(critical?.severity).toBe('error');
    expect(critical?.tier).toBe(2);
    expect(critical?.message).toContain('estimated top-1');
  });

  it('warns on --why for a skill that only a cached older version contains', () => {
    const home = mkdtempSync(join(tmpdir(), 'skill-diag-older-'));
    made.push(home);
    const base = join(home, '.claude', 'plugins', 'cache', 'mp', 'plug');
    const old = join(base, '1.0.0', 'skills', 'legacy');
    const latest = join(base, '2.0.0', 'skills', 'current');
    mkdirSync(old, { recursive: true });
    mkdirSync(latest, { recursive: true });
    writeFileSync(
      join(old, 'SKILL.md'),
      '---\nname: legacy\ndescription: Old behaviour kept for compatibility with earlier installations\n---\n\nBody.\n',
      'utf8',
    );
    writeFileSync(
      join(latest, 'SKILL.md'),
      '---\nname: current\ndescription: Current behaviour that replaced the older installation path\n---\n\nBody.\n',
      'utf8',
    );
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'plug@mp': true } }),
      'utf8',
    );

    const { stdout, code } = runCli(['routing', '--why', 'legacy', '--home', home]);
    expect(stdout).toContain('this skill is a cached older version');
    expect(code).not.toBe(3);
  });
});
