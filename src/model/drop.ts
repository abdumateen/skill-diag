/**
 * Drop simulation (Phase 2c).
 *
 * The contract records that overflow removes *descriptions* (names stay listed)
 * and that the drop order is `unknown` until a working host can be calibrated.
 * With an unknown order the only honest answer is a bound: `none` when the
 * listing fits, `all` when the overflow exceeds every description combined,
 * `exact-count` when the worst and best cases agree, and `range` otherwise.
 * A calibrated, deterministic rule yields the exact set it predicts.
 */

import type { Budget, DropOrder, Skill } from '../types.js';
import { commandName, displayName } from '../types.js';

export type DropSimulation =
  | { kind: 'none'; excessChars: number }
  | { kind: 'all'; count: number; excessChars: number; note: string }
  | { kind: 'exact-count'; count: number; excessChars: number }
  | {
      kind: 'range';
      min: number;
      max: number;
      excessChars: number;
      reason: 'unknown-drop-order';
    }
  | { kind: 'set'; skills: string[]; rule: string; excessChars: number };

export interface DropBehavior {
  namesAlwaysListed: boolean;
  dropOrder: DropOrder;
}

/** Rules the tool can simulate from data it already holds. */
const SIMULATABLE = new Set<string>(['reverse-alphabetical', 'reverse-registration']);

function descriptionCost(skill: Skill, cap: number): number {
  const desc =
    typeof skill.frontmatter['description'] === 'string' ? skill.frontmatter['description'] : '';
  const when =
    typeof skill.frontmatter['when_to_use'] === 'string' ? skill.frontmatter['when_to_use'] : '';
  return Math.min(desc.length + when.length, cap);
}

/** Chars freed when this entry loses its description (name stays listed). */
function freedChars(skill: Skill, cap: number, namesAlwaysListed: boolean): number {
  const desc = descriptionCost(skill, cap);
  return namesAlwaysListed ? desc : desc + displayName(skill).length;
}

function orderedBy(rule: string, skills: readonly Skill[]): Skill[] {
  const list = [...skills];
  if (rule === 'reverse-alphabetical') {
    return list.sort((a, b) => displayName(b).localeCompare(displayName(a)));
  }
  // reverse-registration: discovery order is registration order, so last wins.
  return list.reverse();
}

export function simulateDrop(
  skills: readonly Skill[],
  budget: Budget,
  dropBehavior: DropBehavior,
): DropSimulation | null {
  const excessChars = Math.round(budget.effectiveChars - budget.limitChars);
  if (excessChars <= 0) return { kind: 'none', excessChars: 0 };

  const cap = budget.perEntryCapChars;
  const costs = skills
    .map((s) => freedChars(s, cap, dropBehavior.namesAlwaysListed))
    .filter((c) => c > 0);

  // Nothing can free chars: no description to drop.
  if (costs.length === 0) return null;

  if (SIMULATABLE.has(dropBehavior.dropOrder)) {
    const chosen: string[] = [];
    let freed = 0;
    for (const skill of orderedBy(dropBehavior.dropOrder, skills)) {
      if (freed >= excessChars) break;
      const cost = freedChars(skill, cap, dropBehavior.namesAlwaysListed);
      if (cost === 0) continue;
      freed += cost;
      chosen.push(commandName(skill));
    }
    return { kind: 'set', skills: chosen, rule: dropBehavior.dropOrder, excessChars };
  }

  const N = costs.length;
  const maxDesc = Math.max(...costs);
  const minDesc = Math.max(1, Math.min(...costs));

  if (excessChars >= N * maxDesc) {
    return {
      kind: 'all',
      count: N,
      excessChars,
      note: 'the entire budget is exhausted — all descriptions will be dropped',
    };
  }

  // Lower bound assumes every drop frees the largest description; upper bound
  // assumes every drop frees the smallest. Both clamped to the droppable set.
  const min = Math.max(1, Math.min(N, Math.floor(excessChars / maxDesc)));
  const max = Math.min(N, Math.ceil(excessChars / minDesc));

  if (min === max) return { kind: 'exact-count', count: min, excessChars };

  return { kind: 'range', min, max, excessChars, reason: 'unknown-drop-order' };
}