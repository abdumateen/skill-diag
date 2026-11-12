/**
 * Fixture discipline: every check in the registry must have a passing and a
 * failing golden fixture, and every fixture must correspond to a registered
 * check. A check cannot ship untested, and a fixture cannot outlive its check.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECK_IDS, runChecks } from '../src/checks/index.js';
import { loadContract, type Contract } from '../src/contracts/loader.js';
import { discoverSkills } from '../src/discovery/walk.js';

const ROOT = join(process.cwd(), 'test', 'fixtures', 'tier1');
const CASES = ['pass', 'fail'] as const;

interface CaseOptions {
  contextWindow?: number;
  requiredFields?: string[];
}

function loadCase(checkId: string, kase: (typeof CASES)[number]) {
  const dir = join(ROOT, checkId, kase);
  const optionsPath = join(dir, 'options.json');
  const options: CaseOptions = existsSync(optionsPath)
    ? (JSON.parse(readFileSync(optionsPath, 'utf8')) as CaseOptions)
    : {};

  const base = loadContract();
  const contract: Contract = options.requiredFields
    ? { ...base, frontmatter: { ...base.frontmatter, required: options.requiredFields } }
    : base;

  // A home that does not exist, so a fixture run can never pick up the real
  // ~/.claude skills on the machine running the tests.
  const skills = discoverSkills({ project: dir, home: join(dir, '__no_home__') });
  const report = runChecks(skills, {
    contract,
    ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}),
  });
  return { skills, report, findings: report.findings.filter((f) => f.checkId === checkId) };
}

describe('tier1 fixtures', () => {
  const fixtureDirs = existsSync(ROOT)
    ? readdirSync(ROOT, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    : [];

  it('has a fixture directory for every registered check', () => {
    expect(fixtureDirs).toEqual([...CHECK_IDS].sort());
  });

  for (const checkId of CHECK_IDS) {
    describe(checkId, () => {
      it('has both a pass and a fail case', () => {
        for (const kase of CASES) {
          expect(existsSync(join(ROOT, checkId, kase, '.claude', 'skills'))).toBe(true);
        }
      });

      it('emits nothing for the passing corpus', () => {
        const { skills, findings } = loadCase(checkId, 'pass');
        expect(skills.length).toBeGreaterThan(0);
        expect(findings).toEqual([]);
      });

      it('emits at least one finding for the failing corpus', () => {
        const { skills, findings } = loadCase(checkId, 'fail');
        expect(skills.length).toBeGreaterThan(0);
        expect(findings.length).toBeGreaterThan(0);
        for (const f of findings) {
          expect(f.checkId).toBe(checkId);
          expect(f.message.length).toBeGreaterThan(0);
        }
      });
    });
  }
});
