/**
 * Parse cache (spec §4.3): (path, mtime, size) keying, hit/miss accounting,
 * invalidation on change, silent recovery from a corrupt entry, and --no-cache.
 *
 * The walk is deliberately NOT cached, so these tests assert on parse hits rather
 * than elapsed time.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { discoverSkills } from '../src/discovery/walk.js';
import { ParseCache } from '../src/parser/cache.js';

const root = mkdtempSync(join(tmpdir(), 'skill-diag-cache-'));
const home = join(root, 'home');

function writeSkill(name: string, description: string): void {
  const dir = join(home, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\nBody.\n`,
  );
}

writeSkill('alpha-skill', 'First skill. Use when testing alpha.');
writeSkill('beta-skill', 'Second skill. Use when testing beta.');
writeSkill('gamma-skill', 'Third skill. Use when testing gamma.');

afterAll(() => rmSync(root, { recursive: true, force: true }));

const opts = (cache: ParseCache) => ({ home, project: home, cache });

describe('parse cache', () => {
  it('writes one entry per skill on a cold run', () => {
    const dir = join(root, 'cache-a');
    const cache = new ParseCache({ dir });
    const skills = discoverSkills(opts(cache));

    expect(skills.length).toBe(3);
    expect(cache.hits).toBe(0);
    expect(cache.misses).toBe(3);
    expect(readdirSync(dir).filter((f) => f.endsWith('.json')).length).toBe(3);
  });

  it('serves every skill from cache on a second run', () => {
    const dir = join(root, 'cache-b');
    discoverSkills(opts(new ParseCache({ dir })));

    const second = new ParseCache({ dir });
    const skills = discoverSkills(opts(second));
    expect(skills.length).toBe(3);
    expect(second.hits).toBe(3);
    expect(second.misses).toBe(0);
  });

  it('re-parses a file whose size changed and returns the new value', () => {
    const dir = join(root, 'cache-c');
    discoverSkills(opts(new ParseCache({ dir })));

    writeSkill('beta-skill', 'Second skill, rewritten with a longer description for invalidation.');

    const second = new ParseCache({ dir });
    const skills = discoverSkills(opts(second));
    const beta = skills.find((s) => s.folderName === 'beta-skill');
    expect(second.hits).toBe(2);
    expect(second.misses).toBe(1);
    expect(beta?.frontmatter['description']).toContain('rewritten');
  });

  it('recovers silently from a corrupt cache entry', () => {
    const dir = join(root, 'cache-d');
    discoverSkills(opts(new ParseCache({ dir })));

    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const victim = files[0];
    expect(victim).toBeTruthy();
    writeFileSync(join(dir, victim as string), '{ this is not json');

    const second = new ParseCache({ dir });
    const skills = discoverSkills(opts(second));
    expect(skills.length).toBe(3);
    expect(second.hits).toBe(2);
    expect(second.misses).toBe(1);
    // The corrupt entry is rewritten, so the next run is a clean full hit.
    const repaired = new ParseCache({ dir });
    discoverSkills(opts(repaired));
    expect(repaired.hits).toBe(3);
    expect(repaired.misses).toBe(0);
  });

  it('--no-cache neither reads nor writes', () => {
    const dir = join(root, 'cache-e');
    const disabled = new ParseCache({ dir, enabled: false });
    discoverSkills(opts(disabled));
    expect(disabled.hits).toBe(0);
    expect(disabled.writes).toBe(0);
    // A disabled cache never even creates its directory.
    expect(existsSync(dir) ? readdirSync(dir).length : 0).toBe(0);
  });

  it('noCache on the discovery options disables an otherwise-enabled cache', () => {
    const dir = join(root, 'cache-f');
    const cache = new ParseCache({ dir });
    discoverSkills({ home, project: home, cache, noCache: true });
    expect(cache.writes).toBe(0);
    expect(existsSync(dir) ? readdirSync(dir).length : 0).toBe(0);
  });
});
