/**
 * Command discovery (Phase 2a). Commands are not linted, but they share the
 * listing budget, so their discovery and costing are what makes `effectiveChars`
 * honest instead of skills-only.
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeBudget } from '../src/budget.js';
import { loadContract } from '../src/contracts/loader.js';
import { discoverCommands } from '../src/discovery/commands.js';
import { discoverSkills } from '../src/discovery/walk.js';

const ROOT = join(process.cwd(), 'test', 'fixtures', 'commands');
const WITH = join(ROOT, 'with-commands');
const WITHOUT = join(ROOT, 'no-commands');

describe('command discovery', () => {
  const commands = discoverCommands({ home: WITH, project: WITH });

  it('finds every markdown file under .claude/commands, including nested ones', () => {
    expect(commands.length).toBe(3);
  });

  it('namespaces a nested command by its directories', () => {
    const nested = commands.find((c) => c.path.endsWith('commit.md'));
    expect(nested?.name).toBe('git:commit');
  });

  it('names a top-level command without a namespace', () => {
    const names = commands.map((c) => c.name).sort();
    expect(names).toEqual(['git:commit', 'plain', 'review']);
  });

  it('reads the frontmatter description', () => {
    const review = commands.find((c) => c.name === 'review');
    expect(review?.description).toBe('Review staged changes and report problems.');
  });

  it('falls back to the first body line when there is no frontmatter', () => {
    const plain = commands.find((c) => c.name === 'plain');
    expect(plain?.description).toBe('Just a plain body line with no frontmatter.');
  });

  it('does not treat a skills-only project as having commands', () => {
    expect(discoverCommands({ home: WITHOUT, project: WITHOUT })).toEqual([]);
    expect(discoverSkills({ home: join(WITHOUT, '__none__'), project: WITHOUT }).length).toBe(1);
  });
});

describe('commands in the listing budget', () => {
  it('adds command cost to both rawChars and effectiveChars', () => {
    const contract = loadContract();
    const commands = discoverCommands({ home: WITH, project: WITH });
    const withoutCommands = computeBudget([], contract);
    const withCommands = computeBudget([], contract, { commands });

    const expected = commands.reduce((sum, c) => sum + c.name.length + c.description.length, 0);
    expect(withCommands.rawChars).toBe(expected);
    expect(withCommands.effectiveChars).toBe(expected);
    expect(withoutCommands.effectiveChars).toBe(0);
  });

  it('applies the per-entry cap to a command description', () => {
    const contract = loadContract();
    const longDesc = 'x'.repeat(contract.listingBudget.perEntryCapChars + 500);
    const budget = computeBudget([], contract, {
      commands: [
        { name: 'big', stem: 'big', path: '/tmp/big.md', source: 'user', description: longDesc, discoveryCost: 0 },
      ],
    });
    expect(budget.rawChars).toBe('big'.length + longDesc.length);
    expect(budget.effectiveChars).toBe('big'.length + contract.listingBudget.perEntryCapChars);
  });
});

describe('budget provenance', () => {
  it('reports the overhead as uncalibrated with the recorded reason', () => {
    const budget = computeBudget([], loadContract());
    expect(budget.overhead.calibrated).toBe(false);
    expect(budget.overhead.reason).toContain('host unusable for calibration');
  });

  it('reports the limit as not host-verified with the same reason', () => {
    const contract = loadContract();
    const budget = computeBudget([], contract, { env: {} });
    expect(budget.limitChars).toBe(15000);
    expect(budget.limitVerified).toBe(false);
    expect(budget.limitNote).toBe(contract.listingBudget.calibrationUnavailableReason);
  });
});
