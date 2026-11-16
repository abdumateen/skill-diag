/**
 * Phase 4b: the MCP server, driven as a real client drives it — JSON-RPC
 * over the child process's stdio. The server is spawned from dist/cli.js so
 * the test covers the CLI wiring and the protocol framing, not just the
 * handler functions.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { top1 } from '../src/model/survival.js';

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

const made: string[] = [];
let baseDir: string;
let homeDir: string;
let projectDir: string;
let storePath: string;

beforeAll(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'skill-diag-mcp-'));
  made.push(baseDir);
  homeDir = join(baseDir, 'home');
  projectDir = join(baseDir, 'project');
  storePath = join(baseDir, 'runtime.jsonl');
  mkdirSync(projectDir, { recursive: true });

  const file = join(homeDir, '.claude', 'skills', 'my-skill', 'SKILL.md');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    '---\nname: my-skill\ndescription: Reviews pull requests for correctness and security then writes a summary\n---\n\nBody.\n',
    'utf8',
  );

  // 20 observed sessions, one activation: enough for the join to attach
  // runtime evidence without flagging anything.
  const lines: string[] = [];
  for (let i = 1; i <= 20; i += 1) {
    lines.push(JSON.stringify({ kind: 'session', id: `m${i}` }));
  }
  lines.push(
    JSON.stringify({ kind: 'activation', name: 'my-skill', source: 'user', trigger: 'user', session: 'm1', ts: 1 }),
  );
  writeFileSync(storePath, `${lines.join('\n')}\n`, 'utf8');
});

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A minimal MCP client: newline-delimited JSON-RPC over the child's stdio. */
class McpClient {
  private readonly child: ChildProcess;
  private buffer = '';
  private readonly pending = new Map<number, (response: JsonRpcResponse) => void>();
  private nextId = 1;
  private readonly stderr: string[] = [];
  private exited = false;

  constructor(args: string[]) {
    this.child = spawn(process.execPath, ['dist/cli.js', 'mcp', ...args], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const newline = this.buffer.indexOf('\n');
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const response = JSON.parse(line) as JsonRpcResponse;
        const resolve = this.pending.get(response.id ?? -1);
        if (resolve) {
          this.pending.delete(response.id ?? -1);
          resolve(response);
        }
      }
    });
    this.child.stderr!.setEncoding('utf8');
    this.child.stderr!.on('data', (chunk: string) => this.stderr.push(chunk));
    this.child.on('exit', () => {
      this.exited = true;
    });
  }

  request(method: string, params: unknown, timeoutMs = 20000): Promise<JsonRpcResponse> {
    const id = this.nextId;
    this.nextId += 1;
    const message = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}; stderr: ${this.stderr.join('')}`));
      }, timeoutMs);
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      if (this.exited) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`server exited before ${method}; stderr: ${this.stderr.join('')}`));
        return;
      }
      this.child.stdin!.write(message);
    });
  }

  notify(method: string, params: unknown): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  stop(): void {
    this.child.kill();
  }
}

const hasCli = existsSync('dist/cli.js');

describe.skipIf(!hasCli)('skill-diag mcp', () => {
  it('answers initialize as a standard MCP server', async () => {
    const client = new McpClient(['--home', homeDir, '-p', projectDir, '--store', storePath]);
    try {
      const response = await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0' },
      });
      const result = response.result as {
        protocolVersion: string;
        serverInfo: { name: string; version: string };
        capabilities: { tools?: unknown };
      };
      expect(typeof result.protocolVersion).toBe('string');
      expect(result.serverInfo.name).toBe('skill-diag');
      expect(result.serverInfo.version).toBe(pkg.version);
      expect(result.capabilities.tools).toBeDefined();
      client.notify('notifications/initialized', {});
    } finally {
      client.stop();
    }
  });

  it('lists diagnose_skills, route_skill, and simulate_add with their schemas', async () => {
    const client = new McpClient(['--home', homeDir, '-p', projectDir, '--store', storePath]);
    try {
      await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0' },
      });
      client.notify('notifications/initialized', {});
      const response = await client.request('tools/list', {});
      const result = response.result as {
        tools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
      };
      expect(result.tools.map((tool) => tool.name).sort()).toEqual([
        'diagnose_skills',
        'route_skill',
        'simulate_add',
      ]);

      const diagnoseTool = result.tools.find((tool) => tool.name === 'diagnose_skills')!;
      expect(diagnoseTool.description).toBe(
        'Diagnose why an agent skill is not loading, routing, or scaling. Returns structured findings for a named skill or the whole library.',
      );
      expect(diagnoseTool.inputSchema.type).toBe('object');
      expect(
        Object.keys(diagnoseTool.inputSchema.properties as Record<string, unknown>).sort(),
      ).toEqual(['includeRouting', 'includeRuntime', 'skill']);

      const routeTool = result.tools.find((tool) => tool.name === 'route_skill')!;
      expect(routeTool.inputSchema.type).toBe('object');
      expect(routeTool.inputSchema.required).toEqual(['prompt']);
      expect(Object.keys(routeTool.inputSchema.properties as Record<string, unknown>)).toEqual([
        'prompt',
      ]);

      const simulateTool = result.tools.find((tool) => tool.name === 'simulate_add')!;
      expect(simulateTool.inputSchema.type).toBe('object');
      expect(simulateTool.inputSchema.required).toEqual(['description']);
      expect(
        Object.keys(simulateTool.inputSchema.properties as Record<string, unknown>),
      ).toEqual(['description']);
    } finally {
      client.stop();
    }
  });

  it('route_skill ranks the overlapping description and scores non-overlap at zero', async () => {
    const client = new McpClient(['--home', homeDir, '-p', projectDir, '--store', storePath]);
    try {
      await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0' },
      });
      client.notify('notifications/initialized', {});
      const overlapping = await client.request('tools/call', {
        name: 'route_skill',
        arguments: { prompt: 'reviews pull requests for security' },
      });
      const hit = JSON.parse(
        (overlapping.result as { content: { text: string }[] }).content[0]!.text,
      ) as { matches: { name: string; description: string; similarity: number }[] };
      expect(hit.matches).toHaveLength(1);
      expect(hit.matches[0]!.name).toBe('my-skill');
      expect(hit.matches[0]!.description).toContain('Reviews pull requests');
      expect(hit.matches[0]!.similarity).toBeCloseTo(0.2, 2);

      const unrelated = await client.request('tools/call', {
        name: 'route_skill',
        arguments: { prompt: 'quarterly invoice reconciliation' },
      });
      const miss = JSON.parse(
        (unrelated.result as { content: { text: string }[] }).content[0]!.text,
      ) as { matches: unknown[]; note?: string };
      expect(miss.matches).toEqual([]);
      expect(miss.note).toContain('lexical similarity is 0');
    } finally {
      client.stop();
    }
  });

  it('simulate_add projects N_eff and the top-1 drop from the survival formula', async () => {
    const client = new McpClient(['--home', homeDir, '-p', projectDir, '--store', storePath]);
    try {
      await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0' },
      });
      client.notify('notifications/initialized', {});

      const call = async (description: string) => {
        const response = await client.request('tools/call', {
          name: 'simulate_add',
          arguments: { description },
        });
        return JSON.parse(
          (response.result as { content: { text: string }[] }).content[0]!.text,
        ) as {
          current: { n: number; nEff: number; top1: number };
          projected: { n: number; nEff: number; top1: number };
          delta: number;
          collidesWith: string[];
          warnings: string[];
        };
      };

      // Distinct description: no cluster, so N_eff grows by exactly one.
      const distinct = await call(
        'Generates quarterly financial spreadsheets from invoices with currency normalization and audit trail',
      );
      expect(distinct.current).toEqual({ n: 1, nEff: 1, top1: top1(1) });
      expect(distinct.projected.n).toBe(2);
      expect(distinct.collidesWith).toEqual([]);
      expect(distinct.projected.nEff).toBe(2);
      expect(distinct.projected.top1).toBeCloseTo(top1(2), 10);
      expect(distinct.delta).toBeCloseTo(top1(1) - top1(2), 10);
      expect(distinct.delta).toBeGreaterThan(0);
      expect(distinct.warnings).toEqual([]);

      // Same description as the listed skill: it joins that cluster, so the
      // collision weight pushes N_eff to 3 for N = 2.
      const duplicate = await call(
        'Reviews pull requests for correctness and security then writes a summary',
      );
      expect(duplicate.collidesWith).toEqual(['my-skill']);
      expect(duplicate.projected.n).toBe(2);
      expect(duplicate.projected.nEff).toBe(3);
      expect(duplicate.projected.top1).toBeCloseTo(top1(3), 10);
      expect(duplicate.delta).toBeGreaterThan(top1(1) - top1(2));
    } finally {
      client.stop();
    }
  });

  it('returns the --json corpus report for a bare diagnose_skills call', async () => {
    const client = new McpClient(['--home', homeDir, '-p', projectDir, '--store', storePath]);
    try {
      await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0' },
      });
      client.notify('notifications/initialized', {});
      const response = await client.request('tools/call', { name: 'diagnose_skills', arguments: {} });
      expect(response.error).toBeUndefined();
      const result = response.result as { content: { type: string; text: string }[]; isError?: boolean };
      expect(result.isError).toBeUndefined();
      expect(result.content[0]!.type).toBe('text');
      const payload = JSON.parse(result.content[0]!.text) as {
        version: string;
        tool: { name: string; version: string };
        summary: { skills: number; errors: number; exitCode: number };
        budget: { limitChars: number };
        findings: unknown[];
        routing: { status: string };
        runtime: { sessions: number };
      };
      expect(payload.version).toBe('1');
      expect(payload.tool.name).toBe('skill-diag');
      expect(payload.summary.skills).toBe(1);
      expect(payload.budget.limitChars).toBeGreaterThan(0);
      expect(Array.isArray(payload.findings)).toBe(true);
      // includeRouting and includeRuntime default true: both sections ride along.
      expect(typeof payload.routing.status).toBe('string');
      expect(payload.runtime.sessions).toBe(20);
    } finally {
      client.stop();
    }
  });

  it('filters findings to the requested skill and attaches its runtime row', async () => {
    const client = new McpClient(['--home', homeDir, '-p', projectDir, '--store', storePath]);
    try {
      await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0' },
      });
      client.notify('notifications/initialized', {});
      const response = await client.request('tools/call', {
        name: 'diagnose_skills',
        arguments: { skill: 'my-skill' },
      });
      const result = response.result as { content: { type: string; text: string }[]; isError?: boolean };
      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content[0]!.text) as {
        summary: { skills: number };
        findings: { skill: string }[];
        runtime: { sessions: number; skill: { name: string; activations: number } };
      };
      expect(payload.summary.skills).toBe(1);
      for (const finding of payload.findings) {
        expect(finding.skill).toBe('my-skill');
      }
      expect(payload.runtime.skill).toEqual({
        name: 'my-skill',
        activations: 1,
        zeroActivation: false,
        theftSuspect: false,
        thiefNeighbor: null,
      });
    } finally {
      client.stop();
    }
  });

  it('reports an error for a skill that matches nothing', async () => {
    const client = new McpClient(['--home', homeDir, '-p', projectDir, '--store', storePath]);
    try {
      await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0' },
      });
      client.notify('notifications/initialized', {});
      const response = await client.request('tools/call', {
        name: 'diagnose_skills',
        arguments: { skill: 'no-such-skill-anywhere' },
      });
      const result = response.result as { content: { type: string; text: string }[]; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('no skill matches no-such-skill-anywhere');
    } finally {
      client.stop();
    }
  });

  it('honours includeRouting=false and includeRuntime=false', async () => {
    const client = new McpClient(['--home', homeDir, '-p', projectDir, '--store', storePath]);
    try {
      await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0' },
      });
      client.notify('notifications/initialized', {});
      const response = await client.request('tools/call', {
        name: 'diagnose_skills',
        arguments: { includeRouting: false, includeRuntime: false },
      });
      const result = response.result as { content: { type: string; text: string }[] };
      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
      expect(payload['routing']).toBeUndefined();
      expect(payload['runtime']).toBeUndefined();
      expect(payload['summary']).toBeDefined();
    } finally {
      client.stop();
    }
  });

  it('answers an unknown tool with isError', async () => {
    const client = new McpClient(['--home', homeDir, '-p', projectDir, '--store', storePath]);
    try {
      await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0' },
      });
      client.notify('notifications/initialized', {});
      const response = await client.request('tools/call', { name: 'no_such_tool', arguments: {} });
      const result = response.result as { content: { type: string; text: string }[]; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('unknown tool');
    } finally {
      client.stop();
    }
  });
});
