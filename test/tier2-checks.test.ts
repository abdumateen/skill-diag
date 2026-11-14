/**
 * Phase 3a — the seven Tier 2 checks, driven by a plugin-sourced corpus.
 *
 * A check that only fires on `~/.claude/skills` cannot answer the incumbent's
 * blind spot, so every assertion below reads findings whose `skillSource` is
 * `plugin`. The fixture home is a flat plugin snapshot
 * (`plugins/corpus/skills/<name>/SKILL.md`) with no `settings.json`, which is
 * the shape a corpus snapshot has: no enabled-plugin filter applies.
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runChecks } from '../src/checks/index.js';
import { loadContract } from '../src/contracts/loader.js';
import { discoverCommands } from '../src/discovery/commands.js';
import { discoverSkills } from '../src/discovery/walk.js';
import { resolveUploadMode } from '../src/model/config.js';

const HOME = join(process.cwd(), 'test', 'fixtures', 'plugins', 'home');
const DEDUPE_HOME = join(process.cwd(), 'test', 'fixtures', 'commands-dedupe');
const contract = loadContract();
const skills = discoverSkills({ home: HOME, project: HOME });

function findings(uploadMode?: boolean) {
  return runChecks(skills, {
    contract,
    ...(uploadMode === true ? { uploadMode: true } : {}),
  }).findings;
}

const NEW_CHECKS = [
  'description-collision',
  'trigger-overlap',
  'allowed-tools-mismatch',
  'body-oversized',
  'reference-missing',
  'absolute-path',
  'docs-in-skill-folder',
] as const;

describe('Tier 2 checks reach plugin skills', () => {
  it('discovers the fixture corpus as plugin-sourced', () => {
    expect(skills.length).toBe(5);
    expect(skills.every((s) => s.source === 'plugin')).toBe(true);
  });

  for (const id of NEW_CHECKS) {
    it(`${id} fires and every hit is plugin-sourced`, () => {
      const hits = findings().filter((f) => f.checkId === id);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((f) => f.skillSource === 'plugin')).toBe(true);
      expect(hits.every((f) => f.message.length > 0)).toBe(true);
    });
  }

  it('fires body-oversized past 5,000 chars only', () => {
    const hits = findings().filter((f) => f.checkId === 'body-oversized');
    expect(hits.some((f) => f.skillName === 'big-abs')).toBe(true);
    expect(hits.some((f) => f.skillName === 'docsy')).toBe(false);
  });
});

describe('--upload resolves from the flag only', () => {
  it('stays off without the flag or a config field', () => {
    expect(resolveUploadMode(HOME)).toBe(false);
    expect(resolveUploadMode(HOME, { upload: true })).toBe(true);
    expect(resolveUploadMode(HOME, { upload: false })).toBe(false);
  });
});

describe('--upload flips an upload-rejected field to an error', () => {
  it('stays silent locally for a field the host accepts', () => {
    expect(findings().filter((f) => f.checkId === 'unknown-field')).toEqual([]);
  });

  it('reports it as an error under upload mode', () => {
    const hits = findings(true).filter((f) => f.checkId === 'unknown-field');
    expect(hits.length).toBe(1);
    expect(hits[0]?.severity).toBe('error');
    expect(hits[0]?.skillName).toBe('ref-tools');
    expect(hits[0]?.message).toContain('rejected on claude.ai upload paths');
  });
});

describe('command discovery dedupe', () => {
  it('keeps fewer commands under enabled-latest than under all', () => {
    const all = discoverCommands({ home: DEDUPE_HOME, project: DEDUPE_HOME, dedupe: 'all' });
    const live = discoverCommands({
      home: DEDUPE_HOME,
      project: DEDUPE_HOME,
      dedupe: 'enabled-latest',
    });
    // Two cached alpha versions plus one beta: the raw scan sees three files,
    // the host loads the newest alpha version and nothing else.
    expect(all.length).toBe(3);
    expect(live.length).toBe(1);
    expect(live[0]?.path).toContain('2.0.0');
  });
});