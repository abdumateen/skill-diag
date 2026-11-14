/**
 * Phase 3b — the SARIF document, checked against the official schema.
 *
 * The schema is vendored at `test/fixtures/sarif/sarif-2.1.0.json` (112,469
 * bytes, fetched from https://json.schemastore.org/sarif-2.1.0.json, which
 * mirrors the OASIS 2.1.0 schema: draft-07, 52 definitions) for two reasons —
 * the suite stays offline, and the validator is the specification rather than a
 * shape this repository made up. Ajv is the same validator the other output
 * suites use.
 *
 * Determinism is asserted as byte equality of two complete documents, which is
 * the property GitHub depends on: an unchanged corpus must not look like a new
 * alert set.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { CHECK_IDS, runChecks } from '../src/checks/index.js';
import { loadContract } from '../src/contracts/loader.js';
import { discoverSkills } from '../src/discovery/walk.js';
import { resolveRoutingConfig } from '../src/model/config.js';
import {
  artifactUri,
  buildSarif,
  fingerprint,
  resultLevel,
  SARIF_RULES,
} from '../src/output/sarif.js';
import type { CorpusReport, Finding } from '../src/types.js';

const contract = loadContract();
const HOME = join(process.cwd(), 'test', 'fixtures', 'plugins', 'home');
const VERSION = '0.2.0';

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(
  JSON.parse(readFileSync('test/fixtures/sarif/sarif-2.1.0.json', 'utf8')) as object,
);

/** A failing assertion that names the property path Ajv rejected. */
function schemaErrors(): string {
  return JSON.stringify(validate.errors ?? [], null, 2);
}

function fixtureReport(contextWindow?: number): CorpusReport {
  const skills = discoverSkills({ home: HOME, project: HOME });
  return runChecks(skills, {
    contract,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  });
}

/**
 * A run whose listing is forced over the context-pressure threshold (pct > 80,
 * tokens = effectiveChars/4): the first pass measures the listing, the second
 * pins a window ~90% of that listing. Deterministic — no fixture size guessing.
 */
function pressuredReport(): CorpusReport {
  const first = fixtureReport();
  const tokens = first.budget.effectiveChars / 4;
  return fixtureReport(Math.max(1, Math.ceil(tokens / 0.9)));
}

/** The committed fail fixtures, which drive the routing model with parameters. */
function routingReport(fixture: string, strictRaw = false): CorpusReport {
  const dir = join(process.cwd(), 'test', 'fixtures', 'tier2', fixture, 'fail');
  return runChecks(discoverSkills({ home: dir, project: dir }), {
    contract,
    routing: resolveRoutingConfig(dir),
    strictRaw,
  });
}

function sarif(report: CorpusReport, strictRaw = false) {
  return buildSarif(report, { version: VERSION, root: HOME, strictRaw });
}

type Result = Record<string, unknown>;

function resultsOf(log: ReturnType<typeof sarif>): Result[] {
  return (log.runs[0]?.results ?? []) as Result[];
}

function byRule(log: ReturnType<typeof sarif>, ruleId: string): Result[] {
  return resultsOf(log).filter((r) => r['ruleId'] === ruleId);
}

const fakeFinding = (over: Partial<Finding>): Finding => ({
  checkId: 'absolute-path',
  tier: 2,
  severity: 'warning',
  skillPath: null,
  skillName: 'example',
  skillSource: null,
  message: 'example',
  ...over,
});

describe('SARIF document validates against the official 2.1.0 schema', () => {
  it('accepts a document built from the plugin fixture corpus', () => {
    const log = sarif(fixtureReport());
    expect(validate(log), schemaErrors()).toBe(true);
    expect(resultsOf(log).length).toBeGreaterThan(0);
  });

  it('accepts a document carrying corpus-level findings with no location', () => {
    // Forced over the threshold so `context-pressure` fires — the finding shape
    // that has no file to point at.
    const log = sarif(pressuredReport());
    expect(byRule(log, 'context-pressure')).toHaveLength(1);
    expect(validate(log), schemaErrors()).toBe(true);
  });
});

describe('rules', () => {
  it('carries one rule per check id, in registry order', () => {
    expect(SARIF_RULES.map((r) => r.id)).toEqual([...CHECK_IDS]);
  });

  it('gives every rule the four fields Code Scanning reads', () => {
    for (const rule of SARIF_RULES) {
      expect(rule.shortDescription.text.length, rule.id).toBeGreaterThan(0);
      expect(rule.fullDescription.text.length, rule.id).toBeGreaterThan(0);
      expect(rule.helpUri, rule.id).toMatch(/^https:\/\//);
      expect(['error', 'warning', 'note', 'none'], rule.id).toContain(
        rule.defaultConfiguration.level,
      );
    }
  });

  it('lists every rule even when no finding fired', () => {
    // An empty corpus: `rules` is static and `results` is the only dynamic part.
    const log = sarif(runChecks([], { contract }));
    expect(log.runs[0]?.tool.driver.rules).toHaveLength(CHECK_IDS.length);
    expect(resultsOf(log)).toEqual([]);
    expect(validate(log), schemaErrors()).toBe(true);
  });
});

describe('partialFingerprints', () => {
  it('are byte-identical across two runs over the same corpus', () => {
    expect(JSON.stringify(sarif(fixtureReport()))).toBe(JSON.stringify(sarif(fixtureReport())));
  });

  it('are identical for the same identity and differ for any part of it', () => {
    const base = fingerprint('absolute-path', '.claude/skills/a/SKILL.md', 7);
    expect(base).toBe(fingerprint('absolute-path', '.claude/skills/a/SKILL.md', 7));
    expect(base).not.toBe(fingerprint('body-oversized', '.claude/skills/a/SKILL.md', 7));
    expect(base).not.toBe(fingerprint('absolute-path', '.claude/skills/b/SKILL.md', 7));
    expect(base).not.toBe(fingerprint('absolute-path', '.claude/skills/a/SKILL.md', 8));
  });

  it('match the finding identity the result carries', () => {
    const log = sarif(fixtureReport());
    for (const result of resultsOf(log)) {
      const location = (result['locations'] as Result[] | undefined)?.[0];
      const physical = location?.['physicalLocation'] as Result | undefined;
      const uri = (physical?.['artifactLocation'] as Result | undefined)?.['uri'] as
        | string
        | undefined;
      const region = physical?.['region'] as Result | undefined;
      const expected = fingerprint(
        String(result['ruleId']),
        uri ?? '',
        Number(region?.['startLine'] ?? 1),
      );
      expect(result['partialFingerprints'], String(result['ruleId'])).toEqual({
        primaryLocationLineHash: expected,
      });
    }
  });
});

describe('levels', () => {
  it('drops raw routing estimates to note by default', () => {
    const log = sarif(routingReport('routing-health-critical'));
    const hits = byRule(log, 'routing-health-critical');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.['level']).toBe('note');
    expect(validate(log), schemaErrors()).toBe(true);
  });

  it('keeps them at their raw severity under --strict-raw', () => {
    // Phase 3c: the promotion happens in runChecks, so the report must be built
    // with the same strictRaw the SARIF emitter receives.
    const log = sarif(routingReport('routing-health-critical', true), true);
    expect(byRule(log, 'routing-health-critical')[0]?.['level']).toBe('error');
  });

  it('leaves the rule metadata at the raw severity either way', () => {
    const rule = SARIF_RULES.find((r) => r.id === 'routing-health-critical');
    expect(rule?.defaultConfiguration.level).toBe('error');
    expect(resultLevel(fakeFinding({ checkId: 'routing-health-critical', severity: 'error' }), false)).toBe('note');
    expect(resultLevel(fakeFinding({ checkId: 'routing-health-critical', severity: 'error' }), true)).toBe('error');
    expect(resultLevel(fakeFinding({ severity: 'warning' }), true)).toBe('warning');
  });
});

describe('artifact locations', () => {
  it('are relative and posix inside the scan root', () => {
    const uri = artifactUri(HOME, join(HOME, '.claude', 'plugins', 'corpus', 'skills', 'doc-sy', 'SKILL.md'));
    expect(uri).toBe('.claude/plugins/corpus/skills/doc-sy/SKILL.md');
  });

  it('fall back to the real path outside the scan root instead of inventing one', () => {
    const uri = artifactUri(join(process.cwd(), 'test'), join(process.cwd(), 'elsewhere', 'SKILL.md'));
    expect(uri).not.toContain('..');
    expect(uri.endsWith('/elsewhere/SKILL.md')).toBe(true);
  });

  it('are omitted for findings about the corpus rather than a file', () => {
    const log = sarif(pressuredReport());
    const corpusLevel = byRule(log, 'context-pressure')[0];
    expect(corpusLevel).toBeDefined();
    expect(corpusLevel?.['locations']).toBeUndefined();
    expect(corpusLevel?.['partialFingerprints']).toBeDefined();
  });
});
