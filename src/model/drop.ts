/**
 * Drop simulation (Phase 2c).
 *
 * The contract records that overflow removes *descriptions* (names stay listed)
 * and that the drop order is `unknown` until a working host can be calibrated.
 * With an unknown order the only honest answer is a range; a calibrated,
 * deterministic rule yields the exact set it predicts.
 */

import type { Budget, Skill } from '../types.js';
import { commandName, displayName } from '../types.js';

export type DropSimulation =
  | {
      kind: 'range';
      min: number;
      max: number;
      excessChars: number;
      reason: 'unknown-drop-order';
    }
  | {
      kind: 'set';
      skills: string[];
      rule: string;
      excessChars: number;
    };

export interface DropBehavior {
  namesAlwaysListed: boolean;
  dropOrder: string;
}

/** Rules the tool can simulate from data it already holds. */
const SIMULATABLE = new Set(['reverse-alphabetical', 'reverse-registration']);

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
  if (excessChars <= 0 || skills.length === 0) return null;

  const cap = budget.perEntryCapChars;
  const costs = skills
    .map((s) => freedChars(s, cap, dropBehavior.namesAlwaysListed))
    .filter((c) => c > 0);

  if (costs.length === 0) return null;

  if (!SIMULATABLE.has(dropBehavior.dropOrder)) {
    const maxCost = Math.max(...costs);
    const minCost = Math.min(...costs);
    // Brief §6.1: lower = floor(excess / max description), upper =
    // ceil(excess / min description), clamped to the entries that can free
    // chars at all. An exceeded budget cannot drop nothing, so the lower bound
    // is raised to 1.
    const min = Math.max(1, Math.min(costs.length, Math.floor(excessChars / maxCost)));
    const max = Math.max(min, Math.min(costs.length, Math.ceil(excessChars / minCost)));
    return { kind: 'range', min, max, excessChars, reason: 'unknown-drop-order' };
  }

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