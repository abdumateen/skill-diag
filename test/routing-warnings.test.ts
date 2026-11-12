/**
 * The two routing warnings, at fixture scale and at corpus scale.
 *
 * The committed fixtures drive the threshold with parameters (a two-skill corpus
 * cannot reach 1,300 skills); the generated corpora prove the same checks fire
 * from real sizes.
 */

import { describe, expect, it } from 'vitest';
import { runChecks } from '../src/checks/index.js';
import { loadContract } from '../src/contracts/loader.js';
import { discoverSkills } from '../src/discovery/walk.js';
import { resolveRoutingConfig } from '../src/model/config.js';
import { parseSkillFile } from '../src/parser/skill.js';
import type { Skill } from '../src/types.js';

const contract = loadContract();

function runFixture(dir: string) {
  const skills = discoverSkills({ home: dir, project: dir });
  const routing = resolveRoutingConfig(dir);
  return runChecks(skills, { contract, routing });
}

function generated(count: number): Skill[] {
  const out: Skill[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(
      parseSkillFile({
        path: `/generated/.claude/skills/skill-${i}/SKILL.md`,
        text: `---\nname: skill-${i}\ndescription: Handles workflow ${i} with vocabulary ${i} and apparatus ${i} for pipeline ${i} only\n---\n\nBody.\n`,
        source: 'user',
      }),
    );
  }
  return out;
}

describe('routing-health-at-risk', () => {
  it('stays quiet above 0.60 (pass fixture)', () => {
    const report = runFixture('test/fixtures/tier2/routing-health-at-risk/pass');
    expect(report.findings.filter((f) => f.checkId === 'routing-health-at-risk')).toHaveLength(0);
  });

  it('fires as a warning below 0.60 (fail fixture)', () => {
    const report = runFixture('test/fixtures/tier2/routing-health-at-risk/fail');
    const hits = report.findings.filter((f) => f.checkId === 'routing-health-at-risk');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe('warning');
    expect(hits[0]?.tier).toBe(2);
  });

  it('fires on a generated 1,400-skill corpus', () => {
    const report = runChecks(generated(1400), { contract });
    const hits = report.findings.filter((f) => f.checkId === 'routing-health-at-risk');
    expect(hits).toHaveLength(1);
    expect(report.findings.some((f) => f.checkId === 'routing-health-critical')).toBe(false);
  });
});

describe('routing-health-critical', () => {
  it('stays quiet above the floor (pass fixture)', () => {
    const report = runFixture('test/fixtures/tier2/routing-health-critical/pass');
    expect(report.findings.filter((f) => f.checkId === 'routing-health-critical')).toHaveLength(0);
  });

  it('fires as an error below 0.50 (fail fixture)', () => {
    const report = runFixture('test/fixtures/tier2/routing-health-critical/fail');
    const hits = report.findings.filter((f) => f.checkId === 'routing-health-critical');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe('error');
  });

  it('fires on a generated 2,000-skill corpus', () => {
    const report = runChecks(generated(2000), { contract });
    const hits = report.findings.filter((f) => f.checkId === 'routing-health-critical');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe('error');
  });

  it('does not also emit the warning when critical fires', () => {
    const report = runChecks(generated(2000), { contract });
    expect(report.findings.filter((f) => f.checkId === 'routing-health-at-risk')).toHaveLength(0);
  });
});
