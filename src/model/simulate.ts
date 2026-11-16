/**
 * Phase 7c: the routing-cost projection behind both `simulate_add` (MCP) and
 * `POST /api/simulate` (dashboard). One implementation, so the agent's answer
 * and the human's answer cannot disagree on the same corpus.
 *
 * The hypothetical skill joins the real cluster pass as one more input, so
 * N_eff reflects the duplicates it would actually create instead of assuming
 * today's corpus density holds.
 */

import { descriptionOf } from '../parser/skill.js';
import { displayName, type Skill } from '../types.js';
import { detectClusters, type ClusterInput } from './clusters.js';
import {
  DEFAULT_ROUTING_CONFIG,
  effectiveN,
  ROUTING_CRITICAL_THRESHOLD,
  ROUTING_WARNING_THRESHOLD,
  type RoutingConfig,
} from './routing.js';
import { top1 } from './survival.js';

/** Id the hypothetical skill takes in the cluster pass; never a real path. */
const SIMULATED_ID = '__simulated__';

export interface SimulationCollision {
  readonly name: string;
  /** Jaccard similarity of the two descriptions, 0–1. */
  readonly similarity: number;
}

export interface SimulationReport {
  readonly current: { readonly n: number; readonly nEff: number; readonly top1: number };
  readonly projected: { readonly n: number; readonly nEff: number; readonly top1: number };
  /** Accuracy lost by adding the skill; negative means the corpus got denser. */
  readonly delta: number;
  /** Names only — the MCP payload has carried this shape since Phase 7b. */
  readonly collidesWith: readonly string[];
  readonly collisions: readonly SimulationCollision[];
  readonly warnings: readonly string[];
}

function clusterInput(skill: Skill): ClusterInput {
  return {
    id: skill.path,
    name: displayName(skill),
    description: descriptionOf(skill),
    plugin: skill.plugin ?? null,
  };
}

function clusterOptions(config: RoutingConfig): {
  shingleSize: number;
  threshold: number;
  minTokens: number;
} {
  return {
    shingleSize: config.shingleSize,
    threshold: config.similarityThreshold,
    minTokens: config.minTokens,
  };
}

export function simulateSkillAdd(
  skills: readonly Skill[],
  description: string,
  config: RoutingConfig = DEFAULT_ROUTING_CONFIG,
): SimulationReport {
  const text = description.trim();
  if (text === '') throw new Error('description is required');

  // Current N_eff comes from the same detection pass analyzeRouting uses, so
  // the "current" column matches the Routing view exactly.
  const currentClusters = detectClusters(skills.map(clusterInput), clusterOptions(config));
  const n = skills.length;
  const nEff = effectiveN(
    n,
    currentClusters.clusters.map((cluster) => cluster.size),
    config.collisionWeight,
  );

  const projectedClusters = detectClusters(
    [
      ...skills.map(clusterInput),
      { id: SIMULATED_ID, name: 'simulated-skill', description: text, plugin: null },
    ],
    clusterOptions(config),
  );
  const newN = n + 1;
  const newNEff = effectiveN(
    newN,
    projectedClusters.clusters.map((cluster) => cluster.size),
    config.collisionWeight,
  );

  // The cluster pair list carries the score; keep the best score per skill in
  // case the detection ever groups the same pair more than once.
  const nameOf = new Map(skills.map((skill) => [skill.path, displayName(skill)]));
  const scoreOf = new Map<string, number>();
  for (const cluster of projectedClusters.clusters) {
    if (!cluster.members.includes(SIMULATED_ID)) continue;
    for (const pair of cluster.pairs) {
      if (pair.a !== SIMULATED_ID && pair.b !== SIMULATED_ID) continue;
      const other = pair.a === SIMULATED_ID ? pair.b : pair.a;
      scoreOf.set(other, Math.max(scoreOf.get(other) ?? 0, pair.similarity));
    }
  }
  const collisions: SimulationCollision[] = [...scoreOf.entries()]
    .map(([id, similarity]) => ({ name: nameOf.get(id) ?? id, similarity }))
    .sort((a, b) => b.similarity - a.similarity || a.name.localeCompare(b.name));

  const currentTop1 = top1(nEff, config.params);
  const projectedTop1 = top1(newNEff, config.params);
  const warnings: string[] = [];
  if (projectedTop1 < ROUTING_WARNING_THRESHOLD) {
    warnings.push(
      `projected top-1 ${(projectedTop1 * 100).toFixed(1)}% falls below the ${ROUTING_WARNING_THRESHOLD.toFixed(2)} warning threshold`,
    );
  }
  if (projectedTop1 < ROUTING_CRITICAL_THRESHOLD) {
    warnings.push(
      `projected top-1 ${(projectedTop1 * 100).toFixed(1)}% falls below the ${ROUTING_CRITICAL_THRESHOLD.toFixed(2)} critical threshold`,
    );
  }

  return {
    current: { n, nEff, top1: currentTop1 },
    projected: { n: newN, nEff: newNEff, top1: projectedTop1 },
    delta: currentTop1 - projectedTop1,
    collidesWith: collisions.map((collision) => collision.name),
    collisions,
    warnings,
  };
}