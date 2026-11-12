/**
 * Budget accounting: rawChars and effectiveChars must both be reported, and the
 * overhead constant must be visibly uncalibrated rather than a silent zero.
 */

import { describe, expect, it } from 'vitest';
import { computeBudget, resolveLimit } from '../src/budget.js';
import { loadContract } from '../src/contracts/loader.js';
import { parseSkillFile } from '../src/parser/skill.js';
import type { Skill } from '../src/types.js';

const contract = loadContract();

function skill(name: string, description: string, whenToUse = ''): Skill {
  const when = whenToUse ? `\nwhen_to_use: ${JSON.stringify(whenToUse)}` : '';
  return parseSkillFile({
    path: `/tmp/${name}/SKILL.md`,
    text: `---\nname: ${name}\ndescription: ${JSON.stringify(description)}${when}\n---\n\nbody\n`,
    source: 'user',
  });
}

describe('budget accounting', () => {
  it('reports both rawChars and effectiveChars', () => {
    const b = computeBudget([skill('a-skill', 'x'.repeat(100))], contract);
    expect(b.rawChars).toBeGreaterThan(0);
    expect(b.effectiveChars).toBeGreaterThan(0);
  });

  it('marks the overhead constant uncalibrated and records why', () => {
    const b = computeBudget([skill('a-skill', 'x'.repeat(10))], contract);
    expect(b.overhead.calibrated).toBe(false);
    expect(b.overhead.charsPerEntry).toBe(0);
    expect(b.overhead.note.toLowerCase()).toContain('uncalibrated');
    expect(b.overhead.reason).toContain('host unusable for calibration');
    expect(b.overhead.reason).toContain('0 tokens');
  });

  it('applies the per-entry cap to effectiveChars but not rawChars', () => {
    // 1000 description + 1000 when_to_use = 2000 > 1536 cap.
    const s = skill('a-skill', 'x'.repeat(1000), 'y'.repeat(1000));
    const b = computeBudget([s], contract);
    expect(b.rawChars).toBe('a-skill'.length + 2000);
    expect(b.effectiveChars).toBe('a-skill'.length + contract.listingBudget.perEntryCapChars);
    expect(b.effectiveChars).toBeLessThan(b.rawChars);
  });

  it('defaults to the contract 15,000-char limit', () => {
    const limit = resolveLimit(contract, { env: {} });
    expect(limit.limitChars).toBe(15000);
    expect(limit.exact).toBe(true);
  });

  it('honours precedence: --budget > env > --context-window > default', () => {
    const env = { SLASH_COMMAND_TOOL_CHAR_BUDGET: '9000' };
    expect(resolveLimit(contract, { env, overrideChars: 4000 }).limitChars).toBe(4000);
    expect(resolveLimit(contract, { env, contextWindow: 200000 }).limitChars).toBe(9000);
    expect(resolveLimit(contract, { env: {}, contextWindow: 200000 }).limitChars).toBe(8000);
    expect(resolveLimit(contract, { env: {} }).limitChars).toBe(15000);
  });

  it('flags a corpus that exceeds the limit', () => {
    const many = Array.from({ length: 40 }, (_, i) => skill(`skill-${i}`, 'x'.repeat(500)));
    const b = computeBudget(many, contract);
    expect(b.effectiveChars).toBeGreaterThan(b.limitChars);
    expect(b.percentUsed).toBeGreaterThan(100);
  });
});
