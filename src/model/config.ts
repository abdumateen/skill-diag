/**
 * `.skill-diag.json` (Phase 2b).
 *
 * The routing parameters are published defaults, not our secrets, so they live
 * in a config file the user can copy and edit. Every value is echoed back in
 * output with its provenance, so an override is never mistaken for the paper.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_SURVIVAL_PARAMS,
  parseRoutingParams,
  type SurvivalParams,
} from './survival.js';
import { DEFAULT_ROUTING_CONFIG, type RoutingConfig } from './routing.js';

export const CONFIG_FILENAME = '.skill-diag.json';

export interface ConfigFile {
  routing?: {
    r?: number;
    p?: number;
    source?: string;
    collisionWeight?: number;
    similarityThreshold?: number;
    shingleSize?: number;
    minTokens?: number;
  };
}

export const DEFAULT_CONFIG_FILE = {
  routing: {
    r: DEFAULT_SURVIVAL_PARAMS.r,
    p: DEFAULT_SURVIVAL_PARAMS.p,
    source: 'curse-of-skills-default',
    collisionWeight: DEFAULT_ROUTING_CONFIG.collisionWeight,
    similarityThreshold: DEFAULT_ROUTING_CONFIG.similarityThreshold,
    shingleSize: DEFAULT_ROUTING_CONFIG.shingleSize,
    minTokens: DEFAULT_ROUTING_CONFIG.minTokens,
  },
} as const;

export function configPath(projectDir: string): string {
  return join(projectDir, CONFIG_FILENAME);
}

/** Missing or unreadable config is not an error: defaults are the documented path. */
export function readConfig(projectDir: string): ConfigFile {
  const file = configPath(projectDir);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ConfigFile;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function resolveRoutingConfig(
  projectDir: string,
  opts: { routingParams?: string } = {},
): RoutingConfig {
  const file = readConfig(projectDir).routing ?? {};

  let params: SurvivalParams = DEFAULT_SURVIVAL_PARAMS;
  if (typeof file.r === 'number' || typeof file.p === 'number') {
    const r = typeof file.r === 'number' ? file.r : params.r;
    const p = typeof file.p === 'number' ? file.p : params.p;
    params = {
      r,
      p,
      source: typeof file.source === 'string' ? file.source : `${params.source} (config override)`,
      citation: params.citation,
    };
  }
  if (opts.routingParams) params = parseRoutingParams(opts.routingParams, params);

  const positive = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

  return {
    params,
    collisionWeight:
      typeof file.collisionWeight === 'number' &&
      Number.isFinite(file.collisionWeight) &&
      file.collisionWeight >= 0
        ? file.collisionWeight
        : DEFAULT_ROUTING_CONFIG.collisionWeight,
    similarityThreshold:
      typeof file.similarityThreshold === 'number' &&
      file.similarityThreshold > 0 &&
      file.similarityThreshold <= 1
        ? file.similarityThreshold
        : DEFAULT_ROUTING_CONFIG.similarityThreshold,
    shingleSize: Math.round(positive(file.shingleSize, DEFAULT_ROUTING_CONFIG.shingleSize)),
    minTokens: Math.round(positive(file.minTokens, DEFAULT_ROUTING_CONFIG.minTokens)),
  };
}

export function writeDefaultConfig(projectDir: string): { path: string; created: boolean } {
  const file = configPath(projectDir);
  if (existsSync(file)) return { path: file, created: false };
  writeFileSync(file, `${JSON.stringify(DEFAULT_CONFIG_FILE, null, 2)}\n`);
  return { path: file, created: true };
}
