/**
 * Routing analysis (Phase 2b): the survival estimate, duplicate adjustment,
 * marginal cost, and the mitigation ladder.
 *
 * Two numbers are always reported side by side — P_top1(N) and P_top1(N_eff) —
 * because the gap between them is the finding. A corpus of distinct skills has a
 * structural problem; a corpus of reworded duplicates has a cheaper one.
 */

import { descriptionOf } from '../parser/skill.js';
import type { Skill } from '../types.js';
import { displayName } from '../types.js';
import { detectClusters, type ClusterReport } from './clusters.js';
import {
  DEFAULT_SURVIVAL_PARAMS,
  breakPoint,
  marginalEffect,
  top1,
  type SurvivalParams,
} from './survival.js';

export const ROUTING_WARNING_THRESHOLD = 0.6;
export const ROUTING_CRITICAL_THRESHOLD = 0.5;

export interface RoutingConfig {
  readonly params: SurvivalParams;
  /** How much of a full hazard each extra member of a duplicate cluster adds. */
  readonly collisionWeight: number;
  readonly similarityThreshold: number;
  readonly shingleSize: number;
  readonly minTokens: number;
}

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  params: DEFAULT_SURVIVAL_PARAMS,
  collisionWeight: 1.0,
  similarityThreshold: 0.72,
  shingleSize: 3,
  minTokens: 10,
};

export interface RoutingMember {
  readonly id: string;
  readonly name: string;
  readonly plugin: string | null;
  readonly descriptionChars: number;
  readonly clusterSize: number;
}

export interface MarginalCost {
  readonly name: string;
  readonly path: string;
  readonly plugin: string | null;
  readonly clusterSize: number;
  /** Cost of one more listed skill — identical for every skill by construction. */
  readonly naiveDelta: number;
  /** Cost once cluster membership is accounted for. */
  readonly adjustedDelta: number;
}

export type RungConfidence = 'estimated' | 'not-simulated';

export interface MitigationRung {
  /** Ladder position as specified (1..4), regardless of sort order. */
  readonly rung: number;
  readonly name: string;
  readonly estimatedGain: number | null;
  readonly confidence: RungConfidence;
  readonly basis: string;
}

export interface DuplicatePruningGain {
  readonly cluster: readonly string[];
  readonly size: number;
  readonly gain: number;
}

export interface RoutingReport {
  readonly n: number;
  readonly nEff: number;
  readonly naiveTop1: number;
  readonly adjustedTop1: number;
  readonly status: 'ok' | 'at-risk' | 'critical';
  readonly config: RoutingConfig;
  readonly clusters: {
    readonly count: number;
    readonly sizes: readonly number[];
    readonly clusteredSkills: number;
    readonly insufficient: number;
    readonly pairs: readonly { a: string; b: string; similarity: number }[];
    readonly members: readonly RoutingMember[];
    readonly insufficientNote: string;
  };
  readonly breakPoints: {
    readonly warning: { readonly theta: number; readonly nStar: number; readonly headroom: number };
    readonly critical: { readonly theta: number; readonly nStar: number; readonly headroom: number };
  };
  readonly marginal: {
    readonly naiveDelta: number;
    readonly top: readonly MarginalCost[];
    readonly shortDescriptionFraction: number;
  };
  readonly ladder: readonly MitigationRung[];
  readonly pruning: readonly DuplicatePruningGain[];
}

function pluginKey(skill: Skill): string {
  return skill.plugin ?? skill.source;
}

/** N_eff = N + Σ(k_i − 1) · w over clusters of size k_i ≥ 2. */
export function effectiveN(
  n: number,
  clusterSizes: readonly number[],
  collisionWeight: number,
): number {
  const excess = clusterSizes
    .filter((k) => k >= 2)
    .reduce((sum, k) => sum + (k - 1), 0);
  return n + excess * collisionWeight;
}

export function analyzeRouting(
  skills: readonly Skill[],
  config: RoutingConfig = DEFAULT_ROUTING_CONFIG,
): RoutingReport {
  const n = skills.length;
  const params = config.params;

  const byId = new Map<string, Skill>();
  for (const skill of skills) byId.set(skill.path, skill);

  const clusterReport: ClusterReport = detectClusters(
    skills.map((skill) => ({
      id: skill.path,
      name: displayName(skill),
      description: descriptionOf(skill),
      plugin: skill.plugin ?? null,
    })),
    {
      shingleSize: config.shingleSize,
      threshold: config.similarityThreshold,
      minTokens: config.minTokens,
    },
  );

  const clusterSizeOf = new Map<string, number>();
  for (const cluster of clusterReport.clusters) {
    for (const id of cluster.members) clusterSizeOf.set(id, cluster.size);
  }

  const clusterSizes = clusterReport.clusters.map((c) => c.size);
  const nEff = effectiveN(n, clusterSizes, config.collisionWeight);

  const naiveTop1 = top1(n, params);
  const adjustedTop1 = top1(nEff, params);
  const status: RoutingReport['status'] =
    adjustedTop1 < ROUTING_CRITICAL_THRESHOLD
      ? 'critical'
      : adjustedTop1 < ROUTING_WARNING_THRESHOLD
        ? 'at-risk'
        : 'ok';

  // Naive marginal cost is the same for every skill: the model only sees N.
  const naiveDelta = marginalEffect(n, params);

  // Adjusted cost separates clustered skills from singletons: dropping a
  // clustered skill removes two effective entries (the skill and its excess).
  const top: MarginalCost[] = skills
    .map((skill) => {
      const clusterSize = clusterSizeOf.get(skill.path) ?? 1;
      const drop = clusterSize >= 2 ? 2 : 1;
      return {
        name: displayName(skill),
        path: skill.path,
        plugin: skill.plugin ?? null,
        clusterSize,
        naiveDelta,
        adjustedDelta: marginalEffect(nEff, params, drop),
      };
    })
    .sort(
      (a, b) =>
        b.adjustedDelta - a.adjustedDelta ||
        b.clusterSize - a.clusterSize ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 10);

  const shortDescriptionFraction =
    top.length === 0
      ? 0
      : top.filter((skill) => {
          const source = byId.get(skill.path);
          const chars = source ? descriptionOf(source).length : 0;
          return chars < 100;
        }).length / top.length;

  // --- Mitigation ladder -------------------------------------------------

  // 1. Namespace gating: cross-plugin pairs inside a cluster are the collisions
  //    a namespace boundary would remove.
  let crossPluginPairs = 0;
  for (const cluster of clusterReport.clusters) {
    for (const pair of cluster.pairs) {
      const left = byId.get(pair.a);
      const right = byId.get(pair.b);
      if (left && right && pluginKey(left) !== pluginKey(right)) crossPluginPairs += 1;
    }
  }
  const nEffAfterNamespace = Math.max(n, nEff - crossPluginPairs * config.collisionWeight);
  const namespaceGain = Math.max(0, top1(nEffAfterNamespace, params) - adjustedTop1);

  // 2. Lexical pre-filter: short descriptions are what a keyword gate helps.
  const lexicalGain = shortDescriptionFraction * Math.max(0, naiveTop1 - ROUTING_CRITICAL_THRESHOLD);

  // 4. Duplicate pruning: removing all but one member of a cluster.
  const pruning: DuplicatePruningGain[] = clusterReport.clusters
    .map((cluster) => ({
      cluster: cluster.members.map((id) => displayName(byId.get(id) ?? ({ name: null, folderName: id } as unknown as Skill))),
      size: cluster.size,
      gain:
        top1(nEff - (cluster.size - 1) * config.collisionWeight, params) - adjustedTop1,
    }))
    .sort((a, b) => b.gain - a.gain)
    .slice(0, 3);

  const ladder: MitigationRung[] = [
    {
      rung: 1,
      name: 'namespace-gating',
      estimatedGain: namespaceGain,
      confidence: 'estimated',
      basis: `directional: ${crossPluginPairs} cross-plugin similar pair(s) would stop competing under a namespace boundary; N_eff ${nEff} → ${nEffAfterNamespace}`,
    },
    {
      rung: 2,
      name: 'lexical-pre-filter',
      estimatedGain: lexicalGain,
      confidence: 'estimated',
      basis: `${(shortDescriptionFraction * 100).toFixed(0)}% of the top-10 marginal-cost skills have descriptions under 100 chars, times the naive headroom above the 0.50 floor (${(naiveTop1 - ROUTING_CRITICAL_THRESHOLD).toFixed(3)})`,
    },
    {
      rung: 3,
      name: 'curated-negatives',
      estimatedGain: null,
      confidence: 'not-simulated',
      basis: 'not simulated — estimate requires activation data (Phase 4)',
    },
    {
      rung: 4,
      name: 'duplicate-pruning',
      estimatedGain: pruning.length === 0 ? 0 : pruning.reduce((sum, p) => sum + p.gain, 0),
      confidence: 'estimated',
      basis:
        pruning.length === 0
          ? 'no duplicate clusters at the configured threshold — nothing to prune'
          : `top-${pruning.length} cluster(s) by gain, sizes ${pruning.map((p) => p.size).join('/')}`,
    },
  ];
  // Ranked by estimated gain; `not-simulated` sorts last rather than pretending
  // to a number it does not have.
  ladder.sort(
    (a, b) =>
      (b.estimatedGain ?? -1) - (a.estimatedGain ?? -1) || a.rung - b.rung,
  );

  const warningNStar = breakPoint(ROUTING_WARNING_THRESHOLD, params);
  const criticalNStar = breakPoint(ROUTING_CRITICAL_THRESHOLD, params);

  return {
    n,
    nEff,
    naiveTop1,
    adjustedTop1,
    status,
    config,
    clusters: {
      count: clusterReport.clusters.length,
      sizes: clusterSizes,
      clusteredSkills: clusterSizes.reduce((sum, k) => sum + k, 0),
      insufficient: clusterReport.insufficient.length,
      pairs: clusterReport.clusters.flatMap((c) => c.pairs),
      members: clusterReport.clusters.flatMap((cluster) =>
        cluster.members.map((id) => {
          const skill = byId.get(id);
          return {
            id,
            name: skill ? displayName(skill) : id,
            plugin: skill?.plugin ?? null,
            descriptionChars: skill ? descriptionOf(skill).length : 0,
            clusterSize: cluster.size,
          };
        }),
      ),
      insufficientNote: `${clusterReport.insufficient.length} skill(s) skipped: description under ${config.minTokens} tokens is too short to cluster reliably`,
    },
    breakPoints: {
      warning: {
        theta: ROUTING_WARNING_THRESHOLD,
        nStar: warningNStar,
        headroom: warningNStar - n,
      },
      critical: {
        theta: ROUTING_CRITICAL_THRESHOLD,
        nStar: criticalNStar,
        headroom: criticalNStar - n,
      },
    },
    marginal: { naiveDelta, top, shortDescriptionFraction },
    ladder,
    pruning,
  };
}
