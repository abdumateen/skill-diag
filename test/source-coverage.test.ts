/**
 * Source independence.
 *
 * The Phase 1 acceptance criterion requires `description-capped` and
 * `context-pressure` to run on both user and plugin skills. The corpus has zero
 * `description-capped` occurrences, so a corpus run cannot prove the check
 * reaches plugin skills — this test builds one of each source and checks both.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runChecks } from '../src/checks/index.js';
import { loadContract } from '../src/contracts/loader.js';
import { discoverSkills } from '../src/discovery/walk.js';

const root = mkdtempSync(join(tmpdir(), 'skill-diag-source-'));
const home = join(root, 'home');
const project = join(root, 'project');

function write(rel: string, content: string): void {
  const full = join(home, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function overCapped(name: string): string {
  const description = JSON.stringify('d'.repeat(1000));
  const whenToUse = JSON.stringify('w'.repeat(600));
  return `---\nname: ${name}\ndescription: ${description}\nwhen_to_use: ${whenToUse}\n---\n\nBody.\n`;
}

mkdirSync(project, { recursive: true });
// User source: over the 1,536 per-entry cap.
write('.claude/skills/user-capped/SKILL.md', overCapped('user-capped'));
// Plugin source: same defect, plus a name/folder mismatch the incumbent never checks.
write('.claude/plugins/demo-market__demo/skills/plugin-capped/SKILL.md', overCapped('plugin-capped'));
write(
  '.claude/plugins/demo-market__demo/skills/plugin-mismatch/SKILL.md',
  `---\nname: different-name\ndescription: "A plugin skill whose name does not match its folder."\n---\n\nBody.\n`,
);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('checks are not filtered by skill source', () => {
  const skills = discoverSkills({ home, project });
  const report = runChecks(skills, { contract: loadContract() });

  it('discovers both a user and a plugin skill', () => {
    expect(skills.some((s) => s.source === 'user')).toBe(true);
    expect(skills.some((s) => s.source === 'plugin')).toBe(true);
  });

  it('reports description-capped for the user skill', () => {
    const hits = report.findings.filter(
      (f) => f.checkId === 'description-capped' && f.skillSource === 'user',
    );
    expect(hits.length).toBe(1);
    expect(hits[0]?.message).toContain('1,536');
  });

  it('reports description-capped for the plugin skill', () => {
    const hits = report.findings.filter(
      (f) => f.checkId === 'description-capped' && f.skillSource === 'plugin',
    );
    expect(hits.length).toBe(1);
  });

  it('reports name-folder-mismatch on a plugin skill', () => {
    const hits = report.findings.filter(
      (f) => f.checkId === 'name-folder-mismatch' && f.skillSource === 'plugin',
    );
    expect(hits.length).toBe(1);
    expect(hits[0]?.message).toContain('plugin-mismatch');
  });

  it('reports context-pressure against the whole corpus including plugins', () => {
    // ~3,160 effective chars ≈ 790 tokens; a 500-token window puts that at ~158%.
    const tight = runChecks(skills, { contract: loadContract(), contextWindow: 500 });
    const pressure = tight.findings.filter((f) => f.checkId === 'context-pressure');
    expect(pressure.length).toBe(1);
    expect(pressure[0]?.severity).toBe('error');
  });
});
