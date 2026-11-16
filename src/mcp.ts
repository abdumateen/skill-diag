/**
 * Phase 4b: `skill-diag mcp` — an stdio MCP server that lets the AI coding
 * agent ask "why isn't my skill firing?" mid-run.
 *
 * One tool, `diagnose_skills`, reuses the exact CLI pipeline (discovery,
 * contract, checks, budget) so an MCP answer cannot disagree with the
 * `skill-diag --json` answer on the same corpus. Two flags widen or narrow the
 * answer: `includeRouting` keeps the routing-model findings (they run as part
 * of the normal check registry, so false drops them rather than true adding
 * them twice), `includeRuntime` attaches the Phase 4a activation join.
 * Everything on stdout is protocol — the report travels inside the tool
 * result text.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { runChecks } from './checks/index.js';
import { routingHealthFindings } from './checks/tier2.js';
import { loadContract } from './contracts/loader.js';
import { discoverCommands } from './discovery/commands.js';
import { defaultHome, discoverSkills } from './discovery/walk.js';
import {
  resolveDedupeMode,
  resolveRoutingConfig,
  resolveStrictRaw,
  resolveUploadMode,
} from './model/config.js';
import { DEFAULT_CLUSTER_OPTIONS, jaccard, shingles, tokenize } from './model/clusters.js';
import { analyzeRouting } from './model/routing.js';
import { analyzeRuntimeJoin, loadRuntimeStore } from './model/runtime.js';
import { simulateSkillAdd } from './model/simulate.js';
import { stringify, toJsonFinding, toJsonReport } from './output/json.js';
import { descriptionOf } from './parser/skill.js';
import { displayName, matchSkills, type CorpusReport, type Finding } from './types.js';

export const TOOL_NAME = 'diagnose_skills';
export const TOOL_DESCRIPTION =
  'Diagnose why an agent skill is not loading, routing, or scaling. Returns structured findings for a named skill or the whole library.';

export const TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    skill: {
      type: 'string',
      description: 'Skill name to diagnose. Omit for the whole-corpus summary.',
    },
    includeRuntime: {
      type: 'boolean',
      default: true,
      description:
        'Attach runtime activation evidence when the local store has observed sessions.',
    },
    includeRouting: {
      type: 'boolean',
      default: true,
      description: 'Keep the routing-model findings in the findings list.',
    },
  },
} as const;

export const ROUTE_TOOL_NAME = 'route_skill';
export const ROUTE_TOOL_DESCRIPTION =
  'Score a draft prompt against every listed skill description by lexical 3-shingle Jaccard similarity. Returns the top 5 collisions so the agent sees what a new skill would compete with.';
export const ROUTE_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: 'Draft user prompt or skill description to score against the corpus.',
    },
  },
  required: ['prompt'],
} as const;

export const SIMULATE_TOOL_NAME = 'simulate_add';
export const SIMULATE_TOOL_DESCRIPTION =
  'Project routing top-1 accuracy if one more skill with this description were added. Recomputes N_eff with the duplicate clusters the new skill would join and applies the survival model.';
export const SIMULATE_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    description: {
      type: 'string',
      description: 'Description of the skill that would be added.',
    },
  },
  required: ['description'],
} as const;

export interface McpOptions {
  readonly version: string;
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

interface DiagnoseArgs {
  readonly skill?: string;
  readonly includeRuntime?: boolean;
  readonly includeRouting?: boolean;
}

function readArgs(raw: unknown): DiagnoseArgs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  return {
    ...(typeof record['skill'] === 'string' ? { skill: record['skill'] } : {}),
    ...(typeof record['includeRuntime'] === 'boolean'
      ? { includeRuntime: record['includeRuntime'] }
      : {}),
    ...(typeof record['includeRouting'] === 'boolean'
      ? { includeRouting: record['includeRouting'] }
      : {}),
  };
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function buildReport(opts: McpOptions): { report: CorpusReport; skills: ReturnType<typeof discoverSkills> } {
  const { skills, project } = loadSkills(opts);
  const contract = loadContract(opts.host ?? 'claude-code');
  const commands = discoverCommands({ home: opts.home ?? defaultHome(), project, dedupe: resolveDedupeMode(project, { dedupe: opts.dedupe }), host: opts.host });
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
  return { report, skills };
}

/**
 * The corpus report `--json` emits, filtered to one skill when asked. The
 * summary's error/warning/exit counts follow the filtered findings (toJsonReport
 * recomputes them from the findings it is given); corpus-level fields (budget,
 * coverage, skill and command counts) stay whole-corpus on purpose.
 */
export function diagnose(opts: McpOptions, args: DiagnoseArgs): Record<string, unknown> {
  const { report, skills } = buildReport(opts);
  const includeRouting = args.includeRouting !== false;
  const includeRuntime = args.includeRuntime !== false;

  // runChecks already runs the routing-model findings through the registry at
  // info severity; includeRouting=false narrows the answer by dropping them.
  const findings: readonly Finding[] = includeRouting
    ? report.findings
    : report.findings.filter((f) => !f.checkId.startsWith('routing-health'));

  const matches = args.skill ? matchSkills(skills, args.skill) : null;
  if (args.skill && matches && matches.length === 0) {
    // An empty findings list would read as "the skill is clean" — say instead
    // that the name matched nothing, the same rule the CLI --why path uses.
    throw new Error(`no skill matches ${args.skill}`);
  }
  const paths = matches ? new Set(matches.map((s) => s.path)) : null;
  const scoped = paths
    ? findings.filter((f) => f.skillPath !== null && paths.has(f.skillPath))
    : findings;

  const payload = toJsonReport(
    scoped === report.findings ? report : { ...report, findings: scoped },
    { version: opts.version, strict: false },
  ) as unknown as Record<string, unknown>;

  if (includeRouting) {
    // ponytail: analyzeRouting runs a second time here (runChecks keeps its
    // own copy private); corpus sizes are small, hoist if that ever shows.
    const routing = analyzeRouting(
      skills,
      resolveRoutingConfig(opts.project ?? process.cwd(), { routingParams: opts.routingParams }),
    );
    payload['routing'] = {
      status: routing.status,
      naiveTop1: routing.naiveTop1,
      adjustedTop1: routing.adjustedTop1,
      n: routing.n,
      nEff: routing.nEff,
    };
  }
  if (includeRuntime) {
    const store = loadRuntimeStore(opts.store);
    if (store.sessions.length > 0) {
      const join = analyzeRuntimeJoin(skills, store);
      const runtime: Record<string, unknown> = {
        sessions: join.sessions,
        observedSkills: join.observedSkills,
        zeroActivation: join.zeroActivation,
        theftSuspects: join.theftSuspects,
        topFiring: join.topFiring,
      };
      const row = matches ? join.skills.find((s) => matches.some((m) => m.path === s.path)) : undefined;
      if (row) {
        runtime['skill'] = {
          name: row.name,
          activations: row.activations,
          zeroActivation: row.zeroActivation,
          theftSuspect: row.theftSuspect,
          thiefNeighbor: row.thiefNeighbor,
        };
      }
      payload['runtime'] = runtime;
    }
  }
  return payload;
}

/** Discovery only — the simulation tools need the corpus, not the check suite. */
function loadSkills(opts: McpOptions): {
  skills: ReturnType<typeof discoverSkills>;
  project: string;
} {
  const home = opts.home ?? defaultHome();
  const project = opts.project ?? process.cwd();
  const dedupe = resolveDedupeMode(project, { dedupe: opts.dedupe });
  return { skills: discoverSkills({ home, project, dedupe, host: opts.host }), project };
}

function readTextArg(raw: unknown, key: string): string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${key} is required`);
  }
  const value = (raw as Record<string, unknown>)[key];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key} is required`);
  return value.trim();
}

/**
 * Phase 7b: what a draft prompt would collide with. Same tokenisation and
 * shingle size the duplicate-cluster pass uses, so a high score here is the
 * same signal that would cluster the two skills together.
 */
export function routeSkill(opts: McpOptions, prompt: string): Record<string, unknown> {
  const text = prompt.trim();
  if (text === '') throw new Error('prompt is required');
  const { skills } = loadSkills(opts);
  const size = DEFAULT_CLUSTER_OPTIONS.shingleSize;
  const promptShingles = shingles(tokenize(text), size);
  const matches = skills
    .map((skill) => {
      const description = descriptionOf(skill);
      return {
        name: displayName(skill),
        description,
        similarity: Number(
          jaccard(promptShingles, shingles(tokenize(description), size)).toFixed(4),
        ),
      };
    })
    .filter((row) => row.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity || a.name.localeCompare(b.name))
    .slice(0, 5);

  const payload: Record<string, unknown> = { prompt: text, shingleSize: size, matches };
  if (matches.length === 0) {
    payload['note'] =
      'no skill description shares a 3-shingle with this prompt — lexical similarity is 0 across the corpus';
  }
  return payload;
}

/**
 * Phase 7b: routing cost of one more skill. The projection itself lives in
 * `src/model/simulate.ts` so the dashboard's `POST /api/simulate` answers the
 * same way from the same code.
 */
export function simulateAdd(opts: McpOptions, description: string): Record<string, unknown> {
  const text = description.trim();
  if (text === '') throw new Error('description is required');
  const { skills, project } = loadSkills(opts);
  return {
    description: text,
    ...simulateSkillAdd(
      skills,
      text,
      resolveRoutingConfig(project, { routingParams: opts.routingParams }),
    ),
  };
}

/** Runs the stdio server until stdin closes. Resolves once the transport is up. */
export async function runMcpServer(opts: McpOptions): Promise<number> {
  const server = new Server(
    { name: 'skill-diag', version: opts.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        inputSchema: TOOL_INPUT_SCHEMA,
      },
      {
        name: ROUTE_TOOL_NAME,
        description: ROUTE_TOOL_DESCRIPTION,
        inputSchema: ROUTE_TOOL_INPUT_SCHEMA,
      },
      {
        name: SIMULATE_TOOL_NAME,
        description: SIMULATE_TOOL_DESCRIPTION,
        inputSchema: SIMULATE_TOOL_INPUT_SCHEMA,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const args = request.params.arguments;
      let payload: Record<string, unknown>;
      switch (request.params.name) {
        case TOOL_NAME:
          payload = diagnose(opts, readArgs(args));
          break;
        case ROUTE_TOOL_NAME:
          payload = routeSkill(opts, readTextArg(args, 'prompt'));
          break;
        case SIMULATE_TOOL_NAME:
          payload = simulateAdd(opts, readTextArg(args, 'description'));
          break;
        default:
          return {
            content: [{ type: 'text' as const, text: `unknown tool ${request.params.name}` }],
            isError: true,
          };
      }
      return { content: [{ type: 'text' as const, text: stringify(payload) }] };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: (error as Error).message }],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport());
  return 0;
}
