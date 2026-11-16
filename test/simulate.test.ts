import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTING_CONFIG } from '../src/model/routing.js';
import { simulateSkillAdd } from '../src/model/simulate.js';
import { DEFAULT_SURVIVAL_PARAMS, top1 } from '../src/model/survival.js';
import type { Skill } from '../src/types.js';

const REVIEWER = 'Reviews pull requests for correctness and security then writes a summary';
const UNRELATED =
  'Generates quarterly financial spreadsheets from invoices with currency normalization and audit trail';

function skill(name: string, description: string): Skill {
  return {
    name,
    folderName: name,
    path: `/tmp/${name}/SKILL.md`,
    source: 'user',
    frontmatter: { description },
    body: '',
    keyLines: {},
  };
}

describe('simulateSkillAdd', () => {
  it('costs one clean slot when the description shares nothing', () => {
    const report = simulateSkillAdd([skill('alpha', REVIEWER)], UNRELATED);
    expect(report.current).toEqual({ n: 1, nEff: 1, top1: top1(1) });
    expect(report.projected.n).toBe(2);
    expect(report.projected.nEff).toBe(2);
    expect(report.projected.top1).toBeCloseTo(top1(2), 10);
    expect(report.delta).toBeCloseTo(top1(1) - top1(2), 10);
    expect(report.collisions).toEqual([]);
    expect(report.collidesWith).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('names the skill it collides with and carries the similarity', () => {
    const report = simulateSkillAdd([skill('alpha', REVIEWER)], REVIEWER);
    expect(report.collidesWith).toEqual(['alpha']);
    expect(report.collisions).toHaveLength(1);
    expect(report.collisions[0]!.name).toBe('alpha');
    expect(report.collisions[0]!.similarity).toBeCloseTo(1, 10);
    // The duplicate joins alpha's cluster: N_eff 3 for N = 2.
    expect(report.projected.nEff).toBe(3);
    expect(report.delta).toBeGreaterThan(top1(1) - top1(2));
  });

  it('warns when the projection crosses the 0.60 and 0.50 thresholds', () => {
    const config = {
      ...DEFAULT_ROUTING_CONFIG,
      params: { ...DEFAULT_SURVIVAL_PARAMS, p: 1 },
    };
    const report = simulateSkillAdd([skill('alpha', REVIEWER)], UNRELATED, config);
    // top1(2) = 0.867 · e^-1 = 0.319 — below both floors.
    expect(report.projected.top1).toBeLessThan(0.5);
    expect(report.warnings).toHaveLength(2);
    expect(report.warnings[0]).toContain('0.60');
    expect(report.warnings[1]).toContain('0.50');
  });

  it('rejects a blank description', () => {
    expect(() => simulateSkillAdd([skill('alpha', REVIEWER)], '   ')).toThrow(
      'description is required',
    );
  });
});