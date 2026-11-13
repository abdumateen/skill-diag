import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulateDrop } from '../src/model/drop.js';
import { renderWhy } from '../src/output/human.js';
import type { Budget, CorpusReport, Skill } from '../src/types.js';

function skill(name: string, descLen: number, source: Skill['source'] = 'user'): Skill {
  return {
    name,
    folderName: name,
    path: `/tmp/${name}/SKILL.md`,
    source,
    frontmatter: { description: 'x'.repeat(descLen) },
    body: '',
    keyLines: {},
  };
}

function budgetOf(effectiveChars: number, limitChars = 10_000): Budget {
  return {
    limitChars,
    limitSource: 'test',
    exact: true,
    limitVerified: false,
    limitNote: 'test',
    rawChars: effectiveChars,
    effectiveChars,
    percentUsed: (effectiveChars / limitChars) * 100,
    perEntryCapChars: 1536,
    overhead: { charsPerEntry: 0, calibrated: false, note: 'test' },
  };
}

const UNKNOWN = { namesAlwaysListed: true, dropOrder: 'unknown' } as const;

describe('simulateDrop', () => {
  it('reports a range when the drop order is unknown', () => {
    const skills = [skill('a', 1000), skill('b', 500), skill('c', 200)];
    const sim = simulateDrop(skills, budgetOf(12_000), UNKNOWN);
    // excess 2000: lower = floor(2000/1000)=2, upper = ceil(2000/200)=10 clamped to 3.
    expect(sim).toEqual({
      kind: 'range',
      min: 2,
      max: 3,
      excessChars: 2000,
      reason: 'unknown-drop-order',
    });
  });

  it('reports none when the listing fits the budget', () => {
    expect(simulateDrop([skill('a', 100)], budgetOf(9_000), UNKNOWN)).toEqual({
      kind: 'none',
      excessChars: 0,
    });
  });

  it('reports exact-count when the worst and best case agree', () => {
    const sim = simulateDrop([skill('a', 1000)], budgetOf(10_500), UNKNOWN);
    expect(sim).toEqual({ kind: 'exact-count', count: 1, excessChars: 500 });
  });

  it('reports all when the excess covers every description', () => {
    const sim = simulateDrop([skill('a', 400), skill('b', 400)], budgetOf(11_000), UNKNOWN);
    expect(sim).toEqual({
      kind: 'all',
      count: 2,
      excessChars: 1000,
      note: 'the entire budget is exhausted — all descriptions will be dropped',
    });
  });

  it('names the exact set for a simulatable rule', () => {
    const skills = [skill('zeta', 400), skill('alpha', 400), skill('beta', 400)];
    const sim = simulateDrop(skills, budgetOf(10_700), {
      namesAlwaysListed: true,
      dropOrder: 'reverse-alphabetical',
    });
    expect(sim).toEqual({
      kind: 'set',
      skills: ['zeta', 'beta'],
      rule: 'reverse-alphabetical',
      excessChars: 700,
    });
  });

  it('falls back to a range for an activation-dependent rule', () => {
    const skills = [skill('a', 400), skill('b', 400)];
    const sim = simulateDrop(skills, budgetOf(10_700), {
      namesAlwaysListed: true,
      dropOrder: 'least-recently-invoked',
    });
    expect(sim?.kind).toBe('range');
  });
});

describe('--why drop simulation', () => {
  it('prints the range sentence when the order is unknown', () => {
    const skills = [skill('alpha', 1000), skill('b', 500), skill('c', 200)];
    const report: CorpusReport = {
      host: 'claude-code',
      hostVersionRange: '>=2.0.70',
      contextWindow: 200_000,
      skills,
      commands: [],
      findings: [],
      budget: budgetOf(12_000),
    };
    const out = renderWhy(report, 'alpha', { color: false, dropBehavior: UNKNOWN });
    expect(out).toContain('Between 2 and 3 skill descriptions will be dropped');
    expect(out).toContain('worst-case bound; exact skills require calibration');
    expect(out).toContain('manual-drop-order.sh');
  });

  it('prints the exact set when a rule is calibrated', () => {
    const skills = [skill('zeta', 400), skill('beta', 400)];
    const report: CorpusReport = {
      host: 'claude-code',
      hostVersionRange: '>=2.0.70',
      contextWindow: 200_000,
      skills,
      commands: [],
      findings: [],
      budget: budgetOf(10_700),
    };
    const out = renderWhy(report, 'zeta', {
      color: false,
      dropBehavior: { namesAlwaysListed: true, dropOrder: 'reverse-alphabetical' },
    });
    expect(out).toContain('rule reverse-alphabetical drops 2 descriptions: zeta, beta');
  });
});

describe('schema/report-v1.json', () => {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(
    JSON.parse(readFileSync('schema/report-v1.json', 'utf8')) as object,
  );

  it.each(['why-range.json', 'why-set.json', 'why-none.json', 'why-all.json'])(
    'accepts fixtures/drop/%s',
    (file) => {
    const doc = JSON.parse(readFileSync(`test/fixtures/drop/${file}`, 'utf8')) as object;
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
  });
});