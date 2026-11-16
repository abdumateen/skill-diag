/**
 * Phase 6a: `skill-diag dashboard` — local governance dashboard backend.
 *
 * Express serves the static frontend from dist/dashboard and three read-only
 * endpoints that reuse the exact CLI pipeline (discovery, contract, checks,
 * routing, runtime join), so the dashboard cannot disagree with `--json` on
 * the same corpus. Local-first as ever: no telemetry, no outbound calls, the
 * local browser is the only client.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import type { Express, Response } from 'express';
import { runChecks } from '../checks/index.js';
import { loadContract } from '../contracts/loader.js';
import { discoverCommands } from '../discovery/commands.js';
import { defaultHome, discoverSkills } from '../discovery/walk.js';
import { loadHistory } from '../history.js';
import {
  resolveDedupeMode,
  resolveRoutingConfig,
  resolveStrictRaw,
  resolveUploadMode,
} from '../model/config.js';
import { analyzeRouting } from '../model/routing.js';
import { DEFAULT_CLUSTER_OPTIONS, detectClusters } from '../model/clusters.js';
import {
  analyzeRuntimeJoin,
  DEFAULT_STORE_PATH,
  loadRuntimeStore,
  MIN_SESSIONS,
} from '../model/runtime.js';
import { simulateSkillAdd } from '../model/simulate.js';
import { descriptionOf } from '../parser/skill.js';
import { displayName } from '../types.js';
import pkg from '../../package.json' with { type: 'json' };

export interface DashboardOptions {
  readonly version: string;
  /** Directory holding the built frontend (dist/dashboard). */
  readonly staticDir: string;
  readonly host?: string;
  readonly home?: string;
  readonly project?: string;
  readonly dedupe?: string;
  readonly budget?: string;
  readonly contextWindow?: string;
  readonly routingParams?: string;
  readonly upload?: boolean;
  readonly strictRaw?: boolean;
  readonly store?: string;
}

const DASHBOARD_PORTS: readonly number[] = [3000, 4000];

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Unordered pair key so a similarity lookup survives either endpoint order. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Phase 7c: discovery without the check suite. The simulation endpoint only
 * needs descriptions, so it skips runChecks the way the MCP simulation tools do.
 */
function discover(opts: DashboardOptions): {
  project: string;
  skills: ReturnType<typeof discoverSkills>;
  commands: ReturnType<typeof discoverCommands>;
} {
  const home = opts.home ?? defaultHome();
  const project = opts.project ?? process.cwd();
  const dedupe = resolveDedupeMode(project, { dedupe: opts.dedupe });
  return {
    project,
    skills: discoverSkills({ home, project, dedupe, host: opts.host }),
    commands: discoverCommands({ home, project, dedupe, host: opts.host }),
  };
}

/**
 * The MCP server's pipeline, verbatim: one discovery + one runChecks pass so
 * the dashboard and `skill-diag --json` cannot disagree on the same corpus.
 */
function corpus(opts: DashboardOptions): {
  project: string;
  skills: ReturnType<typeof discoverSkills>;
  commands: ReturnType<typeof discoverCommands>;
  report: ReturnType<typeof runChecks>;
} {
  const contract = loadContract(opts.host ?? 'claude-code');
  const { project, skills, commands } = discover(opts);
  const budgetChars = numberOrUndefined(opts.budget);
  const contextWindow = numberOrUndefined(opts.contextWindow);
  const report = runChecks(skills, {
    contract,
    ...(budgetChars !== undefined ? { overrideChars: budgetChars } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    commands,
    routing: resolveRoutingConfig(project, { routingParams: opts.routingParams }),
    uploadMode: resolveUploadMode(project, { upload: opts.upload }),
    strictRaw: resolveStrictRaw(project, { strictRaw: opts.strictRaw }),
  });
  return { project, skills, commands, report };
}

const envelope = { version: '1', tool: { name: 'skill-diag', version: pkg.version } } as const;

function liveSummary(opts: DashboardOptions): Record<string, unknown> {
  const { project, skills, commands, report } = corpus(opts);
  const routing = analyzeRouting(
    skills,
    resolveRoutingConfig(project, { routingParams: opts.routingParams }),
  );
  const severity = (s: string): number => report.findings.filter((f) => f.severity === s).length;
  return {
    ...envelope,
    source: 'live',
    generatedAt: new Date().toISOString(),
    totalSkills: skills.length,
    totalCommands: commands.length,
    findings: {
      total: report.findings.length,
      errors: severity('error'),
      warnings: severity('warning'),
      info: severity('info'),
    },
    routing: {
      status: routing.status,
      naiveTop1: routing.naiveTop1,
      adjustedTop1: routing.adjustedTop1,
      n: routing.n,
      nEff: routing.nEff,
    },
  };
}

/**
 * `.skill-diag/capability-surface.json` is the cached summary slot: when it
 * exists and carries the expected shape it is served as-is, otherwise the
 * live check runs. Nothing writes the file yet; the shape is the live one.
 */
function cachedSummary(project: string): Record<string, unknown> | null {
  const file = join(project, '.skill-diag', 'capability-surface.json');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    return typeof parsed['totalSkills'] === 'number' ? { ...parsed, source: 'cached' } : null;
  } catch {
    return null;
  }
}

function safe(res: Response, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}

/** Binds the first free port; rejects when every candidate is taken. */
function listenOn(server: Server, ports: readonly number[]): Promise<number> {
  return ports
    .reduce(
      (chain, port) =>
        chain.then((bound) => {
          if (bound !== null) return bound;
          return new Promise<number | null>((resolve) => {
            const onError = (): void => {
              server.removeListener('listening', onListen);
              resolve(null);
            };
            const onListen = (): void => {
              server.removeListener('error', onError);
              resolve(port);
            };
            server.once('error', onError);
            server.once('listening', onListen);
            server.listen(port);
          });
        }),
      Promise.resolve<number | null>(null),
    )
    .then((bound) => {
      if (bound === null) throw new Error(`could not bind dashboard ports ${ports.join(' or ')}`);
      return bound;
    });
}

export interface DashboardHandle {
  readonly port: number;
  close(): Promise<void>;
}

export async function startDashboard(opts: DashboardOptions): Promise<DashboardHandle> {
  // Deferred import: express must not load for any other CLI command —
  // Windows node_modules resolution dominates cold starts (see tsup.config).
  const express = (await import('express')).default;
  const app: Express = express();
  app.disable('x-powered-by');

  app.use(express.json({ limit: '32kb' }));
  app.use(express.static(opts.staticDir));
  app.get('/', (_req, res) => {
    const index = join(opts.staticDir, 'index.html');
    if (existsSync(index)) res.sendFile(index);
    else res.status(404).send('dashboard frontend missing — run `npm run build:dashboard`');
  });

  app.get('/api/summary', (_req, res) =>
    safe(res, () => {
      const project = opts.project ?? process.cwd();
      res.json(cachedSummary(project) ?? liveSummary(opts));
    }),
  );

  app.get('/api/routing', (_req, res) =>
    safe(res, () => {
      const { project, skills } = corpus(opts);
      const routing = analyzeRouting(
        skills,
        resolveRoutingConfig(project, { routingParams: opts.routingParams }),
      );
      res.json({ ...envelope, routing });
    }),
  );

  app.get('/api/runtime', (_req, res) =>
    safe(res, () => {
      const storePath = opts.store ?? DEFAULT_STORE_PATH;
      const store = loadRuntimeStore(storePath);
      const base = { ...envelope, storePath, minSessions: MIN_SESSIONS };
      if (store.sessions.length === 0) {
        res.json({ ...base, hasData: false });
        return;
      }
      const { skills } = corpus(opts);
      const join = analyzeRuntimeJoin(skills, store);
      // The join knows victim → thief by name; the cluster pairs hold the
      // similarity score. One extra detection pass buys the numbers for the
      // theft table without a second discovery + checks run.
      const pathOf = new Map(skills.map((skill) => [displayName(skill), skill.path]));
      const similarityOf = new Map(
        detectClusters(
          skills.map((skill) => ({
            id: skill.path,
            name: displayName(skill),
            description: descriptionOf(skill),
            plugin: skill.plugin ?? null,
          })),
          DEFAULT_CLUSTER_OPTIONS,
        ).clusters.flatMap((cluster) =>
          cluster.pairs.map((pair) => [pairKey(pair.a, pair.b), pair.similarity] as const),
        ),
      );
      const theft = join.skills.flatMap((row) => {
        if (!row.theftSuspect || row.thiefNeighbor === null) return [];
        const thiefPath = pathOf.get(row.thiefNeighbor.name);
        return [
          {
            victim: row.name,
            thief: row.thiefNeighbor.name,
            similarity:
              thiefPath === undefined
                ? null
                : (similarityOf.get(pairKey(row.path, thiefPath)) ?? null),
            thiefActivations: row.thiefNeighbor.activations,
          },
        ];
      });
      res.json({
        ...base,
        hasData: true,
        sessions: join.sessions,
        observedSkills: join.observedSkills,
        zeroActivation: join.zeroActivation,
        theftSuspects: join.theftSuspects,
        topFiring: join.topFiring,
        theft,
      });
    }),
  );

  // Phase 7a: the history file `skill-diag snapshot` appends to. A missing
  // file is an empty history, not an error — the chart shows its hint instead.
  app.get('/api/history', (_req, res) =>
    safe(res, () => {
      res.json(loadHistory(opts.project ?? process.cwd()));
    }),
  );

  // Phase 7c: the same projection `simulate_add` answers over MCP. Local only —
  // the server binds loopback and the browser is the only client.
  app.post('/api/simulate', (req, res) => {
    const body = req.body as { description?: unknown } | undefined;
    const description = typeof body?.description === 'string' ? body.description.trim() : '';
    if (description === '') {
      res.status(400).json({ error: 'description is required' });
      return;
    }
    safe(res, () => {
      const { project, skills } = discover(opts);
      res.json({
        ...envelope,
        description,
        ...simulateSkillAdd(
          skills,
          description,
          resolveRoutingConfig(project, { routingParams: opts.routingParams }),
        ),
      });
    });
  });

  const server = createServer(app);
  const port = await listenOn(server, DASHBOARD_PORTS);
  return {
    port,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}
