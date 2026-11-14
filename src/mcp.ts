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
import { analyzeRouting } from './model/routing.js';
import { analyzeRuntimeJoin, loadRuntimeStore } from './model/runtime.js';
import { stringify, toJsonFinding, toJsonReport } from './output/json.js';
import { matchSkills, type CorpusReport, type Finding } from './types.js';

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
  const contract = loadContract(opts.host ?? 'claude-code');
  const home = opts.home ?? defaultHome();
  const project = opts.project ?? process.cwd();
  const dedupe = resolveDedupeMode(project, { dedupe: opts.dedupe });
  const skills = discoverSkills({ home, project, dedupe });
  const commands = discoverCommands({ home, project, dedupe });
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
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== TOOL_NAME) {
      return {
        content: [{ type: 'text' as const, text: `unknown tool ${request.params.name}` }],
        isError: true,
      };
    }
    try {
      const payload = diagnose(opts, readArgs(request.params.arguments));
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
