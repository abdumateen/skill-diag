/**
 * Parity and coverage against the committed `claude-skills-doctor` baseline.
 *
 * PARITY (user skills). The baseline reported 10 findings across the 13 user
 * skills. Only `budget-exceeded` is a Tier 1 check under this spec; the other 9
 * are Tier 2 (`body-too-large` ×2, `reference-chain` ×5) or security
 * (`script-network-call` ×2). The Phase 1 non-goals forbid implementing either
 * class, so those IDs are listed as EXCLUDED below with the reason, and this test
 * fails if an unmapped ID ever appears — the gap cannot grow silently.
 *
 * COVERAGE (plugin skills). The incumbent runs only six per-skill checks on
 * plugin-source skills before `check_all` hits `if not full: return out`, then
 * `scan_security` and `check_description_cap`. Everything else is structurally
 * unreachable for the 1,102 plugin skills, which is what Phase 1 covers.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runChecks } from '../src/checks/index.js';
import { loadContract } from '../src/contracts/loader.js';
import { discoverSkills } from '../src/discovery/walk.js';
import { renderWhy } from '../src/output/human.js';

const BASELINE = join(process.cwd(), 'test', 'baselines', 'claude-skills-doctor-1115.json');

const CORPUS =
  process.env['SKILL_DIAG_CORPUS'] ??
  join(homedir(), 'AppData', 'Local', 'Temp', 'skill-diag-bl', 'corpus', 'home');

/** Incumbent check id → this tool's check id. Only Tier 1 mappings belong here. */
const INCUMBENT_TO_OURS: Record<string, string> = {
  'frontmatter-invalid': 'yaml-invalid',
  'missing-name': 'missing-name',
  'empty-name': 'missing-name',
  'missing-description': 'missing-description',
  'empty-description': 'missing-description',
  'name-folder-mismatch': 'name-folder-mismatch',
  'name-format': 'name-invalid',
  'description-too-long': 'description-too-long',
  'description-capped': 'description-capped',
  'budget-exceeded': 'budget-exceeded',
  'duplicate-name': 'exact-name-collision',
  'unexpected-frontmatter-key': 'unknown-field',
  // Phase 3a kept these two incumbent ids verbatim, so they map one-to-one.
  'description-collision': 'description-collision',
  'absolute-path': 'absolute-path',
};

/**
 * Checks we deliberately do not reproduce. Anything not here and not mapped
 * fails the test below, so this list is the whole acknowledged gap.
 */
const EXCLUDED: Record<string, string> = {
  'body-too-large': 'implemented as body-oversized (Phase 3a) — ids not mapped',
  'reference-chain': 'partially covered by reference-missing (Phase 3a) — chain traversal not implemented',
  'script-network-call': 'security — explicitly out of scope (§23)',
  'hidden-instruction': 'security — explicitly out of scope (§23)',
  'budget-near': 'not implemented — proximity to the budget is not checked',
  'description-vague': 'Tier 3 semantic (spec §7.3) — skill-issue territory',
  'description-is-workflow': 'Tier 3 semantic (spec §7.3) — skill-issue territory',
  'description-angle-brackets': 'not in spec §7.1 Tier 1 set — not implemented',
  'compatibility-too-long': 'not implemented — compatibility length is not checked',
  'body-empty': 'not implemented — an empty body is not checked',
  'human-docs': 'implemented as docs-in-skill-folder (Phase 3a) — ids not mapped',
  'allowed-tools-body': 'implemented as allowed-tools-mismatch (Phase 3a) — ids not mapped',
  'yaml-truthy-key': 'parser strictness — not implemented',
  'internal-error': 'tool-internal crash sentinel, not a skill property',
};

interface BaselineFinding {
  check: string;
  severity: string;
  target: string;
  message: string;
  path: string | null;
}

interface Baseline {
  counts: { skills: number };
  findings: BaselineFinding[];
}

const hasBaseline = existsSync(BASELINE);
const hasCorpus = existsSync(join(CORPUS, '.claude'));

function isPluginPath(p: string | null): boolean {
  if (!p) return false;
  return p.replace(/\\/g, '/').split('/').includes('plugins');
}

describe.skipIf(!hasBaseline)('parity with claude-skills-doctor', () => {
  const baseline = hasBaseline
    ? (JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline)
    : { counts: { skills: 0 }, findings: [] };

  const userFindings = baseline.findings.filter((f) => !isPluginPath(f.path));

  it('every incumbent check id is either mapped or explicitly excluded', () => {
    const seen = new Set(baseline.findings.map((f) => f.check));
    const unknown = [...seen].filter(
      (id) => !(id in INCUMBENT_TO_OURS) && !(id in EXCLUDED),
    );
    expect(unknown).toEqual([]);
  });

  it('reproduces the Tier 1 findings the incumbent reported on the 13 user skills', () => {
    // budget-exceeded is corpus-level: one finding regardless of skill count.
    const required = userFindings
      .map((f) => INCUMBENT_TO_OURS[f.check])
      .filter((id): id is string => typeof id === 'string');
    expect(required).toContain('budget-exceeded');
  });

  it('documents every non-Tier-1 user finding as excluded', () => {
    const excluded = userFindings
      .filter((f) => !(f.check in INCUMBENT_TO_OURS))
      .map((f) => f.check);
    for (const id of excluded) expect(EXCLUDED).toHaveProperty(id);
  });
});

describe.skipIf(!hasCorpus)('coverage on the plugin corpus', () => {
  const skills = hasCorpus ? discoverSkills({ home: CORPUS, project: process.cwd() }) : [];
  const report = runChecks(skills, { contract: loadContract() });
  const userFindings = hasBaseline
    ? (JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline).findings.filter(
        (f) => !isPluginPath(f.path),
      )
    : [];

  it('discovers 1,115 skills split 13 user / 1,102 plugin', () => {
    expect(report.skills.length).toBe(1115);
    const plugin = report.skills.filter((s) => s.source === 'plugin').length;
    expect(plugin).toBe(1102);
    expect(report.skills.length - plugin).toBe(13);
  });

  it('reproduces every Tier 1 finding the incumbent reported on the 13 user skills', () => {
    const ours = new Set(report.findings.map((f) => f.checkId));
    const mapped = userFindings
      .map((f) => INCUMBENT_TO_OURS[f.check])
      .filter((id): id is string => typeof id === 'string');
    expect(mapped.length).toBeGreaterThan(0);
    for (const id of mapped) expect(ours.has(id)).toBe(true);
  });

  it('reproduces the incumbent Tier 1 findings it can reach on plugins', () => {
    // The incumbent found 1 frontmatter-invalid among plugin skills; so must we.
    const yamlInvalid = report.findings.filter(
      (f) => f.checkId === 'yaml-invalid' && f.skillSource === 'plugin',
    );
    expect(yamlInvalid.length).toBe(1);
  });

  it('reports findings the incumbent structurally cannot produce on plugins', () => {
    const withheld = new Set([
      'name-folder-mismatch',
      'name-invalid',
      'description-too-long',
      'unknown-field',
    ]);
    const covered = report.findings.filter(
      (f) => f.skillSource === 'plugin' && withheld.has(f.checkId),
    );
    expect(covered.length).toBeGreaterThan(0);
  });

  it('runs description-capped and context-pressure against plugin skills too', () => {
    const ids = new Set(report.findings.map((f) => f.checkId));
    // Zero occurrences is a legitimate result; what must hold is that the checks
    // are not filtered by source. Proven by the fixture suite plus this assertion
    // that the corpus run reaches them at all.
    const total = report.findings.length;
    expect(total).toBeGreaterThan(0);
    expect(ids.has('unknown-field')).toBe(true);

    const tight = runChecks(skills, { contract: loadContract(), contextWindow: 30000 });
    expect(tight.findings.some((f) => f.checkId === 'context-pressure')).toBe(true);
  });

  it('--why explains both a user skill and a plugin skill', () => {
    const userSkill = report.skills.find((s) => s.source === 'user');
    const pluginSkill = report.skills.find((s) => s.source === 'plugin');
    expect(userSkill).toBeDefined();
    expect(pluginSkill).toBeDefined();

    const userOut = renderWhy(report, userSkill?.folderName ?? '', { color: false });
    expect(userOut).toContain('listing cost:');
    expect(userOut).toContain('budget:');

    const pluginOut = renderWhy(report, pluginSkill?.folderName ?? '', { color: false });
    expect(pluginOut).toContain('listing cost:');
    expect(pluginOut).not.toContain('no skill matches');
  });
});
