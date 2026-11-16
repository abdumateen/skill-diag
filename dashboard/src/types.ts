/** Shape of GET /api/summary — see src/dashboard/server.ts liveSummary(). */
export interface Summary {
  version: string;
  tool: { name: string; version: string };
  source: string;
  generatedAt: string;
  totalSkills: number;
  totalCommands: number;
  findings: { total: number; errors: number; warnings: number; info: number };
  routing: {
    status: 'ok' | 'at-risk' | 'critical';
    naiveTop1: number;
    adjustedTop1: number;
    n: number;
    nEff: number;
  };
}

/** Headroom at one break point — see src/model/routing.ts ThresholdHeadroom. */
export interface ThresholdHeadroom {
  theta: number;
  nStar: number;
  naiveHeadroom: number;
  adjustedN: number;
  adjustedHeadroom: number;
  adjustedHeadroomAssumption: string;
}

/** Fields of the routing report the Routing view consumes — see src/model/routing.ts RoutingReport. */
export interface RoutingReport {
  n: number;
  nEff: number;
  naiveTop1: number;
  adjustedTop1: number;
  status: 'ok' | 'at-risk' | 'critical';
  config: {
    params: { r: number; p: number; source: string; citation: string };
    similarityThreshold: number;
  };
  clusters: { count: number; clusteredSkills: number; insufficient: number; insufficientNote: string };
  breakPoints: { warning: ThresholdHeadroom; critical: ThresholdHeadroom };
  density: number;
  pruning: { cluster: string[]; size: number; gain: number }[];
}

/** Shape of GET /api/routing — see src/dashboard/server.ts. */
export interface RoutingResponse {
  version: string;
  tool: { name: string; version: string };
  routing: RoutingReport;
}

/** One line of .skill-diag/history.jsonl — see src/history.ts HistorySnapshot. */
export interface HistorySnapshot {
  timestamp: string;
  totalSkills: number;
  routingTop1: number;
  errors: number;
  warnings: number;
}

/** One per-skill row of the runtime join — see src/model/runtime.ts SkillRuntime. */
export interface RuntimeSkillRow {
  name: string;
  path: string;
  plugin: string | null;
  activations: number;
  zeroActivation: boolean;
  theftSuspect: boolean;
  thiefNeighbor: { name: string; activations: number } | null;
}

/** Victim/thief row with the similarity score resolved from the cluster pairs. */
export interface TheftRow {
  victim: string;
  thief: string;
  similarity: number | null;
  thiefActivations: number;
}

/** Shape of GET /api/runtime — see src/dashboard/server.ts. */
export interface RuntimeResponse {
  version: string;
  tool: { name: string; version: string };
  storePath: string;
  minSessions: number;
  hasData: boolean;
  sessions?: number;
  observedSkills?: number;
  zeroActivation?: string[];
  skills?: RuntimeSkillRow[];
  topFiring?: { name: string; activations: number }[];
  theft?: TheftRow[];
}
