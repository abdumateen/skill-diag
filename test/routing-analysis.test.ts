/**
 * Marginal cost and the mitigation ladder (Phase 2b).
 *
 * The naive model is scale-driven, so every skill costs the same; the adjusted
 * column is what separates a duplicate from a singleton. Both are asserted,
 * because "all deltas are equal" is correct rather than a bug and should be
 * stated as such rather than quietly fixed.
 */

import { describe, expect, it } from 'vitest';
import { parseSkillFile } from '../src/parser/skill.js';
import { analyzeRouting, DEFAULT_ROUTING_CONFIG } from '../src/model/routing.js';
import type { Skill } from '../src/types.js';

const SHARED =
  'Reviews pull requests for correctness and security then writes a summary of the findings for the maintainer team';

function skill(name: string, description: string, plugin?: string): Skill {
  return parseSkillFile({
    path: `/corpus/${plugin ?? 'user'}/skills/${name}/SKILL.md`.replace('/user/', '/'),
    text: `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\nBody.\n`,
    source: plugin ? 'plugin' : 'user',
    ...(plugin ? { plugin } : {}),
  });
}

function distinctSkills(count: number): Skill[] {
  const out: Skill[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(
      skill(
        `skill-${i}`,
        `Handles workflow number ${i} with vocabulary ${i} and apparatus ${i} for pipeline ${i} only`,
      ),
    );
  }
  return out;
}

describe('marginal cost', () => {
  it('is uniform across skills in the naive model, and says so', () => {
    const report = analyzeRouting(distinctSkills(50));
    const deltas = new Set(report.marginal.top.map((m) => m.naiveDelta));
    expect(deltas.size).toBe(1);
    expect(report.clusters.count).toBe(0);
    expect(report.nEff).toBe(50);
    expect(report.naiveTop1).toBe(report.adjustedTop1);
  });

  it('charges a clustered skill roughly twice a singleton once adjusted', () => {
    const skills = [
      skill('a', SHARED, 'plug-one'),
      skill('b', SHARED, 'plug-one'),
      ...distinctSkills(20),
    ];
    const report = analyzeRouting(skills);
    expect(report.clusters.count).toBe(1);
    // 22 skills plus one excess member: N_eff = 22 + (2-1).
    expect(report.nEff).toBe(23);

    const clustered = report.marginal.top.find((m) => m.clusterSize === 2);
    const singleton = report.marginal.top.find((m) => m.clusterSize === 1);
    expect(clustered).toBeDefined();
    expect(singleton).toBeDefined();
    expect((clustered as { adjustedDelta: number }).adjustedDelta).toBeGreaterThan(
      (singleton as { adjustedDelta: number }).adjustedDelta,
    );
  });

  it('reports at most ten contributors, sorted by adjusted cost', () => {
    const report = analyzeRouting([...distinctSkills(40), skill('dup-a', SHARED), skill('dup-b', SHARED)]);
    expect(report.marginal.top.length).toBe(10);
    const values = report.marginal.top.map((m) => m.adjustedDelta);
    expect(values).toEqual([...values].sort((a, b) => b - a));
  });
});

describe('mitigation ladder', () => {
  it('ranks rungs by estimated gain and keeps not-simulated last', () => {
    const report = analyzeRouting([
      skill('a', SHARED, 'plug-one'),
      skill('b', SHARED, 'plug-two'),
      ...distinctSkills(30),
    ]);
    const gains = report.ladder.map((r) => r.estimatedGain ?? -1);
    expect(gains).toEqual([...gains].sort((a, b) => b - a));
    expect(report.ladder[report.ladder.length - 1]?.confidence).toBe('not-simulated');
  });

  it('states that curated negatives cannot be simulated', () => {
    const report = analyzeRouting(distinctSkills(10));
    const curated = report.ladder.find((r) => r.name === 'curated-negatives');
    expect(curated?.confidence).toBe('not-simulated');
    expect(curated?.estimatedGain).toBeNull();
    expect(curated?.basis).toContain('Phase 4');
  });

  it('reports duplicate-pruning gains per cluster and marks an empty corpus honestly', () => {
    const withDupes = analyzeRouting([
      skill('a', SHARED),
      skill('b', SHARED),
      skill('c', SHARED),
      ...distinctSkills(30),
    ]);
    const pruning = withDupes.ladder.find((r) => r.name === 'duplicate-pruning');
    expect(pruning?.estimatedGain).toBeGreaterThan(0);
    expect(withDupes.pruning.length).toBe(1);
    expect(withDupes.pruning[0]?.size).toBe(3);

    const clean = analyzeRouting(distinctSkills(10));
    const nothing = clean.ladder.find((r) => r.name === 'duplicate-pruning');
    expect(nothing?.estimatedGain).toBe(0);
    expect(nothing?.basis).toContain('nothing to prune');
  });

  it('estimates namespace gating from cross-plugin pairs only', () => {
    const crossPlugin = analyzeRouting([
      skill('a', SHARED, 'plug-one'),
      skill('b', SHARED, 'plug-two'),
      ...distinctSkills(20),
    ]);
    const gating = crossPlugin.ladder.find((r) => r.name === 'namespace-gating');
    expect(gating?.confidence).toBe('estimated');
    expect(gating?.estimatedGain).toBeGreaterThan(0);
    expect(gating?.basis).toContain('cross-plugin');

    const samePlugin = analyzeRouting([skill('a', SHARED, 'plug-one'), skill('b', SHARED, 'plug-one')]);
    const noGain = samePlugin.ladder.find((r) => r.name === 'namespace-gating');
    expect(noGain?.estimatedGain).toBe(0);
  });

  it('honours the collision weight when computing N_eff', () => {
    const skills = [skill('a', SHARED), skill('b', SHARED), ...distinctSkills(10)];
    const one = analyzeRouting(skills, { ...DEFAULT_ROUTING_CONFIG, collisionWeight: 1 });
    const two = analyzeRouting(skills, { ...DEFAULT_ROUTING_CONFIG, collisionWeight: 2 });
    expect(two.nEff - one.nEff).toBe(1);
  });
});
