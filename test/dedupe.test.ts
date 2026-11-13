/**
 * Discovery dedupe (Phase 2c.3). Synthetic `~/.claude` trees so each rule is
 * pinned to one filesystem shape instead of to whatever this machine happens to
 * have cached.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDedupeMode } from '../src/model/config.js';
import { discoverSkills, discoverSkillsDetailed, readEnabledPlugins } from '../src/discovery/walk.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'skill-diag-dedupe-'));
  roots.push(dir);
  return dir;
}

function skill(home: string, rel: string, description: string): void {
  const file = join(home, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `---\nname: ${rel.split(/[\\/]/).at(-2)}\ndescription: ${JSON.stringify(description)}\n---\n\nBody.\n`,
    'utf8',
  );
}

function settings(home: string, enabled: Record<string, boolean>): void {
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: enabled }), 'utf8');
}

const DESC = 'Analyse the dataset and report every finding with a reviewer-grade summary of results';

describe('dedupe: enabled-latest', () => {
  it('keeps only the newest cached version of a plugin', () => {
    const home = tempHome();
    settings(home, { 'plug@mp': true });
    skill(home, '.claude/plugins/cache/mp/plug/1.0.0/skills/alpha/SKILL.md', DESC);
    skill(home, '.claude/plugins/cache/mp/plug/10.0.0/skills/alpha/SKILL.md', DESC);

    const { skills, dedupe } = discoverSkillsDetailed({ home, project: home, dedupe: 'enabled-latest' });
    expect(skills.length).toBe(1);
    expect(dedupe.removed.oldVersions).toBe(1);
    expect(skills[0]?.path).toContain('10.0.0');
  });

  it('drops skills from plugins that are not enabled', () => {
    const home = tempHome();
    settings(home, { 'on@mp': true, 'off@mp': false });
    skill(home, '.claude/plugins/cache/mp/on/1.0.0/skills/kept/SKILL.md', DESC);
    skill(home, '.claude/plugins/cache/mp/off/1.0.0/skills/dropped/SKILL.md', DESC);

    const { skills, dedupe } = discoverSkillsDetailed({ home, project: home, dedupe: 'enabled-latest' });
    expect(skills.map((s) => s.folderName)).toEqual(['kept']);
    expect(dedupe.removed.disabledPlugins).toBe(1);
  });

  it('prefers the cache copy over the marketplace checkout of the same plugin', () => {
    const home = tempHome();
    settings(home, { 'plug@mp': true });
    skill(home, '.claude/plugins/cache/mp/plug/1.0.0/skills/alpha/SKILL.md', DESC);
    skill(home, '.claude/plugins/marketplaces/mp/plug/skills/alpha/SKILL.md', `${DESC} edited`);

    const { skills, dedupe } = discoverSkillsDetailed({ home, project: home, dedupe: 'enabled-latest' });
    expect(skills.length).toBe(1);
    expect(dedupe.removed.marketplaceCopies).toBe(1);
  });

  it('drops a marketplace skill whose content is byte-identical to a cached one', () => {
    const home = tempHome();
    settings(home, { 'plug@mp': true, 'other@mp': true });
    skill(home, '.claude/plugins/cache/mp/plug/1.0.0/skills/alpha/SKILL.md', DESC);
    // Same folder name keeps the generated file byte-identical (the helper
    // derives `name:` from the folder), which is what the SHA-1 rule tests.
    skill(home, '.claude/plugins/marketplaces/mp/other/skills/alpha/SKILL.md', DESC);

    const { skills, dedupe } = discoverSkillsDetailed({ home, project: home, dedupe: 'enabled-latest' });
    expect(skills.length).toBe(1);
    expect(dedupe.removed.duplicateContent).toBe(1);
  });

  it('keeps user and project skills alongside plugin skills', () => {
    const home = tempHome();
    const project = join(home, 'work');
    settings(home, { 'plug@mp': true });
    skill(home, '.claude/skills/mine/SKILL.md', DESC);
    skill(project, '.claude/skills/shared/SKILL.md', DESC);
    skill(home, '.claude/plugins/cache/mp/plug/1.0.0/skills/alpha/SKILL.md', DESC);

    const { skills } = discoverSkillsDetailed({ home, project, dedupe: 'enabled-latest' });
    expect(skills.map((s) => s.source).sort()).toEqual(['plugin', 'project', 'user']);
  });

  it('leaves a flat corpus snapshot untouched', () => {
    const home = tempHome();
    skill(home, '.claude/plugins/plug-a/skills/alpha/SKILL.md', DESC);
    skill(home, '.claude/plugins/plug-b/skills/beta/SKILL.md', DESC);

    const { skills, dedupe } = discoverSkillsDetailed({ home, project: home, dedupe: 'enabled-latest' });
    expect(skills.length).toBe(2);
    expect(dedupe.pluginSkillsAfter).toBe(dedupe.pluginSkillsBefore);
  });
});

describe('dedupe: other modes', () => {
  it('keeps every SKILL.md on disk for `all` and its alias `off`', () => {
    const home = tempHome();
    settings(home, { 'plug@mp': true });
    skill(home, '.claude/plugins/cache/mp/plug/1.0.0/skills/alpha/SKILL.md', DESC);
    skill(home, '.claude/plugins/cache/mp/plug/2.0.0/skills/alpha/SKILL.md', DESC);
    skill(home, '.claude/plugins/marketplaces/mp/plug/skills/alpha/SKILL.md', DESC);

    expect(discoverSkills({ home, project: home, dedupe: 'all' }).length).toBe(3);
    expect(discoverSkills({ home, project: home, dedupe: 'off' }).length).toBe(3);
  });

  it('falls back to the heuristic when settings are unreadable, and says so', () => {
    const home = tempHome();
    skill(home, '.claude/plugins/cache/mp/plug/1.0.0/skills/alpha/SKILL.md', DESC);

    expect(readEnabledPlugins(home).plugins).toBeNull();
    const { skills, dedupe } = discoverSkillsDetailed({ home, project: home, dedupe: 'enabled-latest' });
    expect(skills.length).toBe(1);
    expect(dedupe.pluginsEnabled).toBeNull();
    expect(dedupe.source).toBe('heuristic, settings unreadable');
  });
});

describe('resolveDedupeMode', () => {
  it('defaults to enabled-latest, reads config, and lets the flag win', () => {
    const project = tempHome();
    expect(resolveDedupeMode(project)).toBe('enabled-latest');

    writeFileSync(join(project, '.skill-diag.json'), JSON.stringify({ dedupe: 'all' }), 'utf8');
    expect(resolveDedupeMode(project)).toBe('all');
    expect(resolveDedupeMode(project, { dedupe: 'enabled-latest' })).toBe('enabled-latest');
    expect(resolveDedupeMode(project, { dedupe: 'off' })).toBe('off');
  });
});