/**
 * The three acceptance corpora for Phase 2b.
 *
 * 1. Published calibration: 2,029 distinct skills must land at ~0.488.
 * 2. Duplicate-heavy: 500 descriptions × 4 copies must move the estimate by
 *    more than 0.10, or the adjustment is too weak to be worth shipping.
 * 3. The live corpus: 1,115 skills, warned about only if the model actually
 *    crosses a line (it does not).
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverSkills } from '../src/discovery/walk.js';
import { analyzeRouting, DEFAULT_ROUTING_CONFIG } from '../src/model/routing.js';
import { PUBLISHED_CALIBRATION } from '../src/model/survival.js';
import { parseSkillFile } from '../src/parser/skill.js';
import type { Skill } from '../src/types.js';

function distinctSkill(name: string, seed: number): Skill {
  return parseSkillFile({
    path: `/corpus/.claude/skills/${name}/SKILL.md`,
    text: `---\nname: ${name}\ndescription: Handles workflow ${seed} with vocabulary ${seed} and apparatus ${seed} for pipeline ${seed} only\n---\n\nBody.\n`,
    source: 'user',
  });
}

function distinct(count: number): Skill[] {
  const out: Skill[] = [];
  for (let i = 0; i < count; i += 1) out.push(distinctSkill(`skill-${i}`, i));
  return out;
}

const CORPUS = join(homedir(), 'AppData/Local/Temp/skill-diag-bl/corpus/home');
const EMPTY = join(homedir(), 'AppData/Local/Temp/skill-diag-emptyhome');

describe('calibration fixture (N=2,029)', () => {
  const skills = distinct(2029);
  const report = analyzeRouting(skills);

  it('lands within 0.05 of the published 0.488', () => {
    expect(report.naiveTop1).toBeGreaterThan(
      PUBLISHED_CALIBRATION.pTop1 - PUBLISHED_CALIBRATION.tolerance,
    );
    expect(report.naiveTop1).toBeLessThan(
      PUBLISHED_CALIBRATION.pTop1 + PUBLISHED_CALIBRATION.tolerance,
    );
  });

  it('finds no duplicates at threshold 0.72', () => {
    expect(report.clusters.count).toBe(0);
    expect(report.nEff).toBe(2029);
  });
});

describe('duplicate-heavy fixture (500 × 4)', () => {
  const skills: Skill[] = [];
  for (let group = 0; group < 500; group += 1) {
    const description = `Group ${group} performs a specific analysis of dataset ${group} and reports the findings for reviewer ${group} in detail`;
    for (let copy = 0; copy < 4; copy += 1) {
      skills.push(
        parseSkillFile({
          path: `/corpus/.claude/plugins/plug-${group}/skills/copy-${copy}/SKILL.md`,
          text: `---\nname: copy-${copy}\ndescription: ${JSON.stringify(description)}\n---\n\nBody.\n`,
          source: 'plugin',
          plugin: `plug-${group}`,
        }),
      );
    }
  }
  const report = analyzeRouting(skills);

  it('estimates ~0.49 naively and ~0.32 duplicate-adjusted', () => {
    expect(report.naiveTop1).toBeCloseTo(0.49, 2);
    expect(report.nEff).toBe(3500);
    expect(report.adjustedTop1).toBeCloseTo(0.32, 2);
  });

  it('moves the estimate by more than 0.10', () => {
    expect(report.adjustedTop1).toBeLessThan(report.naiveTop1 - 0.1);
  });

  it('finds all 500 clusters of size four', () => {
    expect(report.clusters.count).toBe(500);
    expect(report.clusters.sizes.every((size) => size === 4)).toBe(true);
  });

  it('reports pruning gains per cluster, biggest first', () => {
    const pruning = report.ladder.find((r) => r.name === 'duplicate-pruning');
    // Each individual cluster is 3 of 3,500 effective entries, so a single
    // prune is small: the value here is N_eff, not any one cluster.
    expect(pruning?.estimatedGain).toBeGreaterThan(0);
    expect(report.pruning.length).toBe(3);
    expect(report.pruning.every((p) => p.size === 4)).toBe(true);
    expect(report.pruning[0]?.gain).toBeGreaterThanOrEqual(report.pruning[1]?.gain ?? 0);
  });
});

describe.skipIf(!existsSync(CORPUS))('live corpus (N=1,115)', () => {
  const skills = discoverSkills({ home: CORPUS, project: EMPTY });
  const report = analyzeRouting(skills, DEFAULT_ROUTING_CONFIG);

  it('has the expected size and naive estimate', () => {
    expect(skills.length).toBe(1115);
    expect(report.naiveTop1).toBeCloseTo(0.633, 2);
  });

  it('reports the duplicate-adjusted estimate alongside it', () => {
    expect(report.adjustedTop1).toBeLessThanOrEqual(report.naiveTop1);
    expect(report.adjustedTop1).toBeGreaterThan(0.6);
    expect(report.nEff).toBeGreaterThanOrEqual(1115);
  });

  it('computes naive headroom to both lines rather than hardcoding it', () => {
    // P(1302) = 0.59996 <= 0.60 and P(1301) = 0.60013, so 1302 is the crossing.
    expect(report.breakPoints.warning.nStar).toBe(1302);
    expect(report.breakPoints.warning.naiveHeadroom).toBe(1302 - skills.length);
    expect(report.breakPoints.warning.naiveHeadroom).toBe(187);
    // P(1946) = 0.499998 — already at the floor, so 1946 is the crossing, not 1947.
    expect(report.breakPoints.critical.nStar).toBe(1946);
    expect(report.breakPoints.critical.naiveHeadroom).toBe(1946 - skills.length);
    expect(report.breakPoints.critical.naiveHeadroom).toBe(831);
  });

  it('computes adjusted headroom at the observed cluster density', () => {
    const density = report.nEff / report.n;
    expect(report.density).toBeCloseTo(1215 / 1115, 6);
    // N_eff = density · N_new, so the line is reached at ceil(N* / density).
    expect(report.breakPoints.warning.adjustedN).toBe(Math.ceil(1302 / density));
    expect(report.breakPoints.warning.adjustedHeadroom).toBe(Math.ceil(1302 / density) - 1115);
    expect(report.breakPoints.warning.adjustedHeadroom).toBe(80);
    expect(report.breakPoints.critical.adjustedN).toBe(Math.ceil(1946 / density));
    expect(report.breakPoints.critical.adjustedHeadroom).toBe(Math.ceil(1946 / density) - 1115);
    expect(report.breakPoints.critical.adjustedHeadroom).toBe(671);
    expect(report.breakPoints.warning.adjustedHeadroomAssumption).toContain('cluster density held constant');
  });
});
