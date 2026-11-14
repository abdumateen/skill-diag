/**
 * Command discovery against the REAL home, not the synthetic corpus.
 *
 * The corpus has no commands, so `commandCount: 0` proves nothing about whether
 * discovery works at scale. Two facts drive this test, both measured:
 *
 *   1. `~/.claude/commands` does not exist on this machine. Every command lives
 *      under `~/.claude/plugins/**\/commands/`, so plugin command discovery is
 *      required to find any of them.
 *   2. The baseline (claude-skills-doctor) counted 905 commands / 75,073 chars.
 *      It costs each command by its bare stem, ignoring the `plugin:` namespace
 *      the host actually shows. We report both: the stem figure for comparison,
 *      and the namespaced figure as the true listing cost.
 *
 * Read-only: this never writes to ~/.claude.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeBudget } from '../src/budget.js';
import { loadContract } from '../src/contracts/loader.js';
import { discoverCommands } from '../src/discovery/commands.js';
import type { DedupeMode } from '../src/discovery/walk.js';

/**
 * `all` on purpose. The incumbent's 905 is an every-markdown-file-on-disk count,
 * so comparing against it needs the raw scan. Deduped discovery is a different
 * question and is measured by the corpus tests instead.
 */
const RAW: { dedupe: DedupeMode } = { dedupe: 'all' };

const HOME = homedir();
const hasPlugins = existsSync(join(HOME, '.claude', 'plugins'));

const BASELINE_COMMANDS = 905;
const BASELINE_STEM_CHARS = 75073;
const DRIFT = 0.05;

describe.skipIf(!hasPlugins)('command discovery on the real home', () => {
  const commands = discoverCommands({ home: HOME, project: process.cwd(), ...RAW });
  const stemChars = commands.reduce(
    (sum, c) => sum + c.stem.length + Math.min(c.description.length, 1536),
    0,
  );
  const namespacedChars = commands.reduce((sum, c) => sum + c.discoveryCost, 0);

  it('finds the commands the incumbent counts', () => {
    expect(commands.length).toBeGreaterThan(Math.floor(BASELINE_COMMANDS * (1 - DRIFT)));
    expect(commands.length).toBeLessThan(Math.ceil(BASELINE_COMMANDS * (1 + DRIFT)));
  });

  it('reproduces the incumbent stem-based character contribution', () => {
    expect(stemChars).toBeGreaterThan(Math.floor(BASELINE_STEM_CHARS * (1 - DRIFT)));
    expect(stemChars).toBeLessThan(Math.ceil(BASELINE_STEM_CHARS * (1 + DRIFT)));
  });

  it('namespaces plugin commands, which the incumbent does not', () => {
    const namespaced = commands.filter((c) => c.name.includes(':'));
    expect(namespaced.length).toBeGreaterThan(0);
    // Ours is strictly larger than the incumbent's figure by the namespace cost.
    expect(namespacedChars).toBeGreaterThan(stemChars);
    const overhead = namespacedChars - stemChars;
    const expectedOverhead = commands.reduce(
      (sum, c) => sum + (c.name.length - c.stem.length),
      0,
    );
    expect(overhead).toBe(expectedOverhead);
  });

  it('raises effectiveChars by the namespaced command contribution', () => {
    const contract = loadContract();
    const skillsOnly = computeBudget([], contract, { env: {} });
    const withCommands = computeBudget([], contract, { env: {}, commands });
    expect(withCommands.effectiveChars - skillsOnly.effectiveChars).toBe(namespacedChars);
  });
});
