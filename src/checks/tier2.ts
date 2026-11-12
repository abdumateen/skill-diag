/**
 * Tier 2 checks shipped in v0.1: `context-pressure` (Phase 1) and the two
 * routing-health warnings (Phase 2b).
 *
 * Other Tier 2 work — description collisions, trigger overlap — is Phase 3, and
 * shipping it now would be scope creep against a brief that asks for the routing
 * regression surface.
 */

import {
  ROUTING_CRITICAL_THRESHOLD,
  ROUTING_WARNING_THRESHOLD,
} from '../model/routing.js';
import type { Finding, Skill } from '../types.js';
import { displayName } from '../types.js';
import type { Check, CheckContext } from './tier1.js';

function finding(
  checkId: string,
  skill: Skill | null,
  severity: Finding['severity'],
  message: string,
): Finding {
  return {
    checkId,
    tier: 2,
    severity,
    skillPath: skill?.path ?? null,
    skillName: skill ? displayName(skill) : 'routing',
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
        'context-pressure',
        null,
        severity,
        `system prompt estimated at ${Math.round(tokens).toLocaleString('en-US')}/${contextWindow.toLocaleString('en-US')} tokens (${pct.toFixed(1)}%)`,
      ),
    ];
  },
};

/**
 * `routing-health-at-risk` is the warning band, `routing-health-critical` is
 * below it. They are mutually exclusive: a corpus at 0.45 gets the error and not
 * also the warning, because one condition should not produce two findings.
 */
export const routingHealthAtRisk: Check = {
  id: 'routing-health-at-risk',
  tier: 2,
  run: ({ routing }: CheckContext) => {
    if (!routing) return [];
    if (routing.adjustedTop1 >= ROUTING_WARNING_THRESHOLD) return [];
    if (routing.adjustedTop1 < ROUTING_CRITICAL_THRESHOLD) return [];
    return [
      finding(
        'routing-health-at-risk',
        null,
        'warning',
        `estimated top-1 ${routing.adjustedTop1.toFixed(3)} at N_eff=${routing.nEff.toLocaleString('en-US')} is below the ${ROUTING_WARNING_THRESHOLD.toFixed(2)} warning line; the line is crossed at N ≈ ${routing.breakPoints.warning.nStar.toLocaleString('en-US')}`,
      ),
    ];
  },
};

export const routingHealthCritical: Check = {
  id: 'routing-health-critical',
  tier: 2,
  run: ({ routing }: CheckContext) => {
    if (!routing) return [];
    if (routing.adjustedTop1 >= ROUTING_CRITICAL_THRESHOLD) return [];
    return [
      finding(
        'routing-health-critical',
        null,
        'error',
        `estimated top-1 ${routing.adjustedTop1.toFixed(3)} at N_eff=${routing.nEff.toLocaleString('en-US')} is below the ${ROUTING_CRITICAL_THRESHOLD.toFixed(2)} floor; the router is guessing more often than routing`,
      ),
    ];
  },
};

export const TIER2_CHECKS: readonly Check[] = [
  contextPressure,
  routingHealthAtRisk,
  routingHealthCritical,
];
