/**
 * Tier 2 checks that Phase 1 must ship because the acceptance criterion names
 * them explicitly: `context-pressure` run on both user and plugin skills.
 *
 * Nothing else from Tier 2 is implemented here — description collisions, trigger
 * overlap and the rest are Phase 3, and shipping them now would be scope creep
 * against a greenlight that says Tier 1 only.
 */

import type { Finding, Skill } from '../types.js';
import { displayName } from '../types.js';
import type { Check, CheckContext } from './tier1.js';

function finding(skill: Skill | null, severity: Finding['severity'], message: string): Finding {
  return {
    checkId: 'context-pressure',
    tier: 2,
    severity,
    skillPath: skill?.path ?? null,
    skillName: skill ? displayName(skill) : 'context',
    skillSource: skill?.source ?? null,
    message,
  };
}

export const contextPressure: Check = {
  id: 'context-pressure',
  tier: 2,
  run: ({ budget, contextWindow }: CheckContext) => {
    const charsPerToken = 4;
    const tokens = budget.effectiveChars / charsPerToken;
    const pct = contextWindow > 0 ? (tokens / contextWindow) * 100 : 0;
    if (pct <= 80) return [];
    const severity: Finding['severity'] = pct > 95 ? 'error' : 'warning';
    return [
      finding(
        null,
        severity,
        `system prompt estimated at ${Math.round(tokens).toLocaleString('en-US')}/${contextWindow.toLocaleString('en-US')} tokens (${pct.toFixed(1)}%)`,
      ),
    ];
  },
};

export const TIER2_CHECKS: readonly Check[] = [contextPressure];
