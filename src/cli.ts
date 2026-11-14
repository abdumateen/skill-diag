#!/usr/bin/env node
/**
 * `skill-diag` CLI — Phase 1 surface plus Phases 2–4d.
 *
 * Implemented: default lint (Tier 1 + Tier 2), `budget`, `routing`, `--why`,
 * `--json`, `--strict`, `--home`, `--project`, `--context-window`, `--budget`,
 * `--dedupe`, `--upload`, `--sarif`, `--strict-raw`, `runtime ingest`,
 * `runtime report`, `mcp`, `--fix`, `--llm`.
 * Not implemented on purpose: graph. That is a later phase, and a stub that
 * prints nothing would be worse than no command at all.
 */

import { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import { computeBudget, resolveContextWindow } from './budget.js';
import { runChecks } from './checks/index.js';
import { routingHealthFindings } from './checks/tier2.js';
import { loadContract } from './contracts/loader.js';
import { discoverCommands } from './discovery/commands.js';
import { defaultHome, discoverSkills, discoverSkillsDetailed } from './discovery/walk.js';
import { applyMechanicalFixes } from './fix.js';
import {
  resolveDedupeMode,
  resolveRoutingConfig,
  resolveStrictRaw,
  resolveUploadMode,
  writeDefaultConfig,
} from './model/config.js';
import { analyzeRouting, type RoutingReport } from './model/routing.js';
import {
  analyzeRuntimeJoin,
  DEFAULT_STORE_PATH,
  ingestOtelFile,
  loadRuntimeStore,
  whyRuntimeFor,
} from './model/runtime.js';
import { gradeDescriptions } from './llm.js';
import {
  exitCodeFor,
  stringify,
  toJsonFinding,
  toJsonReport,
  toWhyJson,
} from './output/json.js';
import { renderHuman, renderWhy } from './output/human.js';
import {
  explainRouting,
  renderRoutingHuman,
  renderRoutingWhy,
  toRoutingJson,
} from './output/routing.js';
import { renderRuntimeHuman, toRuntimeJson } from './output/runtime.js';
import { buildSarif } from './output/sarif.js';
import { runMcpServer } from './mcp.js';
import { matchSkills } from './types.js';

// Static import: works under tsup, vitest, and bun --compile (a runtime
// createRequire('../package.json') cannot resolve inside a compiled binary).
import pkg from '../package.json' with { type: 'json' };

interface CommonOpts {
  json?: boolean;
  strict?: boolean;
  why?: string;
  home?: string;
  project?: string;
  contextWindow?: string;
  budget?: string;
  quiet?: boolean;
  color?: boolean;
  host?: string;
  routingParams?: string;
  dedupe?: string;
  upload?: boolean;
  sarif?: string;
  strictRaw?: boolean;
  otel?: string;
  store?: string;
  fix?: boolean;
  llm?: boolean;
}

/**
 * Commander hands a flag declared on both the program and a subcommand to the
 * *parent*, so a subcommand's own `opts()` silently lacks `--json`, `--home`,
 * `-p` and friends. Merge both, child last: before this, `budget --json` printed
 * human output and every subcommand ignored `--home`.
 */
function mergedOpts(cmd: Command): CommonOpts {
  return { ...program.opts<CommonOpts>(), ...cmd.opts<CommonOpts>() };
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function addCommonOptions(cmd: Command): Command {
  return cmd
    .option('--json', 'machine-readable output')
    .option('--strict', 'Tier 2 warnings also produce a non-zero exit')
    .option('--why <skill>', 'explain every finding for one skill')
    .option('--home <path>', 'home directory override (reads ~/.claude)')
    .option('-p, --project <path>', 'project root override (reads .claude/skills)')
    .option('--context-window <tokens>', 'context window used to derive a budget (default: contract default)')
    .option('--budget <chars>', 'pin the listing budget in characters')
    .option('--quiet', 'suppress human output; exit code only')
    .option('--no-color', 'disable colour')
    .option('--routing-params <r,p>', 'override the published survival parameters (e.g. 0.867,0.000283)')
    .option('--dedupe <mode>', 'discovery dedupe: enabled-latest (default), all, off')
    .option('--upload', 'the corpus ships to claude.ai: fail on upload-rejected frontmatter fields')
    .option('--host <host>', 'host contract: claude-code (default), cursor, codex, gemini-cli', 'claude-code');
}

function execute(opts: CommonOpts, mode: 'lint' | 'budget'): number {
  const contract = loadContract(opts.host ?? 'claude-code');
  const home = opts.home ?? defaultHome();
  const project = opts.project ?? process.cwd();
  const dedupe = resolveDedupeMode(project, { dedupe: opts.dedupe });
  let skills = discoverSkills({ home, project, dedupe, host: opts.host });
  // Commands share the listing budget, so they are discovered and counted even
  // though Phase 1/2a does not lint them. Non-claude hosts have no commands.
  const commands = discoverCommands({ home, project, dedupe, host: opts.host });

  const budgetOptions = {
    ...(numberOrUndefined(opts.budget) !== undefined
      ? { overrideChars: numberOrUndefined(opts.budget) as number }
      : {}),
    ...(numberOrUndefined(opts.contextWindow) !== undefined
      ? { contextWindow: numberOrUndefined(opts.contextWindow) as number }
      : {}),
  };

  const routing = resolveRoutingConfig(project, { routingParams: opts.routingParams });
  const uploadMode = resolveUploadMode(project, { upload: opts.upload });
  const strictRaw = resolveStrictRaw(project, { strictRaw: opts.strictRaw });
  const checkOptions = {
    contract,
    ...budgetOptions,
    commands,
    routing,
    uploadMode,
    strictRaw,
  };
  let report = runChecks(skills, checkOptions);

  // Phase 4d: --fix applies only mechanical repairs, then re-discovers and
  // re-checks so the report describes the corpus as it now stands. The diff
  // goes to stderr under --json so the protocol stream stays clean.
  if (mode === 'lint' && opts.fix) {
    const sink = opts.json
      ? (text: string) => process.stderr.write(text)
      : (text: string) => process.stdout.write(text);
    applyMechanicalFixes(skills, {
      findings: report.findings,
      contract,
      capChars: report.budget.perEntryCapChars,
      write: sink,
    });
    skills = discoverSkills({ home, project, dedupe, host: opts.host });
    report = runChecks(skills, checkOptions);
  }

  // Phase 4d: --llm grades descriptions through a local CLI. Verdicts land as
  // info findings, so they inform but never move the exit code.
  if (mode === 'lint' && opts.llm && !opts.quiet) {
    const scope = opts.why ? matchSkills(skills, opts.why) : skills;
    const grade = gradeDescriptions(scope, { bin: process.env['SKILL_DIAG_LLM_BIN'] });
    if (grade.available) {
      report = { ...report, findings: [...report.findings, ...grade.findings] };
      if (!opts.json && (grade.graded > 0 || grade.failed > 0)) {
        process.stdout.write(
          `llm grading via ${grade.bin}: ${grade.graded} graded, ${grade.failed} failed, ${grade.findings.length} flagged\n`,
        );
      }
    } else {
      process.stderr.write(
        'no local grading CLI found (tried claude, codex; set SKILL_DIAG_LLM_BIN to override)\n',
      );
    }
  }

  const strict = opts.strict === true;
  const exitCode = exitCodeFor(report, strict);

  // Written before any output branch so `--sarif out.sarif --quiet` is the CI
  // shape. The document never depends on `--strict`: that flag decides the exit
  // code, and a reviewer reading the SARIF should see the same thing either way.
  if (opts.sarif) {
    const log = buildSarif(report, {
      version: pkg.version,
      root: project,
      strictRaw,
    });
    writeFileSync(opts.sarif, `${JSON.stringify(log, null, 2)}\n`);
  }

  if (mode === 'budget') {
    const b = report.budget;
    if (opts.json) {
      process.stdout.write(
        stringify(toJsonReport(report, { version: pkg.version, strict })),
      );
      return 0;
    }
    const contributors = [
      ...skills.map((s) => {
        const name = s.name ?? s.folderName;
        const desc = typeof s.frontmatter['description'] === 'string' ? s.frontmatter['description'] : '';
        const when = typeof s.frontmatter['when_to_use'] === 'string' ? s.frontmatter['when_to_use'] : '';
        return { name, cost: name.length + Math.min(desc.length + when.length, b.perEntryCapChars) };
      }),
      ...commands.map((c) => ({ name: `${c.name} (command)`, cost: c.discoveryCost })),
    ]
      .sort((a, z) => z.cost - a.cost)
      .slice(0, 15);
    const lines = [
      `skill-diag v${pkg.version} · host: ${report.host} ${report.hostVersionRange}`,
      `listing budget ${b.effectiveChars.toLocaleString('en-US')} / ${b.limitChars.toLocaleString('en-US')} chars (${b.percentUsed.toFixed(1)}%)`,
      `raw chars ${b.rawChars.toLocaleString('en-US')} · effective chars ${b.effectiveChars.toLocaleString('en-US')}`,
      `skills ${skills.length} · commands ${commands.length}`,
      `limit from ${b.limitSource}${b.exact ? '' : ' (estimated)'}${b.limitVerified ? '' : ' — not host-verified'}`,
      `overhead ${b.overhead.charsPerEntry} chars/entry — ${b.overhead.calibrated ? 'calibrated' : 'uncalibrated'}`,
      ...(b.overhead.calibrated ? [] : [`calibration unavailable: ${b.overhead.reason ?? 'reason not recorded'}`]),
      '',
      'biggest contributors:',
      ...contributors.map((c) => `  ${String(c.cost).padStart(6)}  ${c.name}`),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }

  if (opts.why) {
    // A skill that only exists in a cached older plugin version is not in the
    // active set; say so plainly instead of "no skill matches".
    if (matchSkills(skills, opts.why).length === 0) {
      const raw = discoverSkills({ home, project, dedupe: 'all', host: opts.host });
      if (matchSkills(raw, opts.why).length > 0) {
        process.stdout.write(
          'this skill is a cached older version; it is not in your active skill set.\n',
        );
        return exitCode;
      }
    }
    const dropBehavior = contract.dropBehavior;
    // Phase 4a: runtime evidence joins the --why output when the local store
    // has observed sessions; an empty store keeps the static-only report.
    const store = loadRuntimeStore(opts.store);
    const runtimeJoin = store.sessions.length > 0 ? analyzeRuntimeJoin(skills, store) : null;
    if (opts.json) {
      process.stdout.write(
        stringify(
          toWhyJson(report, opts.why, { version: pkg.version, dropBehavior, runtime: runtimeJoin }),
        ),
      );
      return exitCode;
    }
    process.stdout.write(
      renderWhy(report, opts.why, { color: opts.color !== false, dropBehavior, runtime: runtimeJoin }),
    );
    return exitCode;
  }

  if (opts.quiet) return exitCode;

  if (opts.json) {
    process.stdout.write(stringify(toJsonReport(report, { version: pkg.version, strict })));
    return exitCode;
  }

  process.stdout.write(
    `${renderHuman(report, { version: pkg.version, color: opts.color !== false, exitCode })}\n`,
  );
  return exitCode;
}

const program = new Command();
program
  .name('skill-diag')
  .description('Capability surface observability for agent skills')
  .version(pkg.version);

addCommonOptions(program);
// Declared on the program so every surface shares it: the main lint and the
// `routing` subcommand both gate on it, and SARIF mirrors the resolved value.
// `budget` accepts it harmlessly — its report has no exit gate of its own.
program
  .option('--sarif <path>', 'write a SARIF v2.1.0 report for GitHub Code Scanning')
  .option(
    '--strict-raw',
    'promote routing-model findings from info to their natural severity; they then affect exit codes and SARIF levels',
  )
  .option('--store <path>', 'runtime store path override (default ~/.cache/skill-diag/runtime.jsonl)')
  .option(
    '--fix',
    'apply unambiguous mechanical fixes (name/folder mismatch, over-long description); semantic issues are left alone',
  )
  .option(
    '--llm',
    'grade descriptions with a local CLI (claude or codex, or SKILL_DIAG_LLM_BIN); advisory info findings only',
  );
program.action(() => {
  process.exitCode = execute(mergedOpts(program), 'lint');
});

const budgetCommand = program.command('budget').description('Show the listing budget and its biggest contributors');
addCommonOptions(budgetCommand);
budgetCommand.action(() => {
  process.exitCode = execute(mergedOpts(budgetCommand), 'budget');
});

/**
 * Phase 3c exit semantics: the gate follows the deduped (active) estimate —
 * `critical` always fails, `at-risk` fails only under `--strict`. The raw scan
 * no longer drags the exit code down on its own; under `--strict-raw` its
 * promoted findings rejoin the gate, so a raw critical fails the run again.
 */
function routingExitCode(status: RoutingReport['status'], strict: boolean): 0 | 1 | 2 {
  if (status === 'critical') return 1;
  if (status === 'at-risk' && strict) return 2;
  return 0;
}

function executeRouting(opts: CommonOpts): number {
  const home = opts.home ?? defaultHome();
  const project = opts.project ?? process.cwd();
  const mode = resolveDedupeMode(project, { dedupe: opts.dedupe });
  const config = resolveRoutingConfig(project, { routingParams: opts.routingParams });

  const active = discoverSkillsDetailed({ home, project, dedupe: mode, host: opts.host });
  const report = analyzeRouting(active.skills, config);
  const rawOnly = mode === 'all' || mode === 'off';
  const raw = rawOnly
    ? null
    : analyzeRouting(discoverSkills({ home, project, dedupe: 'all', host: opts.host }), config);

  const strict = opts.strict === true;
  const strictRaw = resolveStrictRaw(project, { strictRaw: opts.strictRaw });
  let exitCode = routingExitCode(report.status, strict);
  if (strictRaw && raw) {
    // A promoted raw finding enters the gate at its natural severity: an error
    // fails outright, a warning only under --strict — the same rule the main
    // command applies through exitCodeFor.
    const rawExit = routingExitCode(raw.status, strict);
    if (rawExit === 1 || exitCode === 1) exitCode = 1;
    else if (rawExit === 2 || exitCode === 2) exitCode = 2;
  }

  if (opts.why) {
    const target = matchSkills(active.skills, opts.why)[0];
    if (!target) {
      const older = matchSkills(
        rawOnly ? active.skills : discoverSkills({ home, project, dedupe: 'all', host: opts.host }),
        opts.why,
      );
      if (older.length > 0) {
        process.stdout.write(
          'this skill is a cached older version; it is not in your active skill set.\n',
        );
        return exitCode;
      }
      process.stderr.write(`no skill matches ${opts.why}\n`);
      return 3;
    }
    // Phase 4a: runtime evidence rides along when the store has sessions.
    const runtime = whyRuntimeFor(active.skills, target, loadRuntimeStore(opts.store));
    if (opts.json) {
      process.stdout.write(
        stringify({
          version: '1',
          tool: { name: 'skill-diag', version: pkg.version },
          ...explainRouting(target, report, mode),
          ...(runtime ? { runtime } : {}),
        }),
      );
      return exitCode;
    }
    process.stdout.write(
      renderRoutingWhy(target, report, {
        version: pkg.version,
        color: opts.color !== false,
        mode,
        runtime,
      }),
    );
    return exitCode;
  }

  // The routing subcommand reports both estimates' findings; the main report
  // stays active-only so a deduped install is not alarmed by its own cache.
  // Both estimates' findings carry `info` until --strict-raw promotes them.
  const seen = new Set<string>();
  const findings = [
    ...routingHealthFindings(report, strictRaw),
    ...(raw ? routingHealthFindings(raw, strictRaw) : []),
  ].filter((f) => (seen.has(f.checkId) ? false : (seen.add(f.checkId), true)));

  if (opts.quiet) return exitCode;
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        toRoutingJson(report, {
          version: pkg.version,
          findings: findings.map(toJsonFinding),
          dedupe: active.dedupe,
          raw,
        }),
        null,
        2,
      )}\n`,
    );
    return exitCode;
  }
  process.stdout.write(
    renderRoutingHuman(report, {
      version: pkg.version,
      color: opts.color !== false,
      raw,
      dedupe: active.dedupe,
    }),
  );
  return exitCode;
}

const routingCommand = program
  .command('routing')
  .description('Estimate top-1 routing health, duplicate clusters, marginal cost and mitigation');
addCommonOptions(routingCommand);
routingCommand.action(() => {
  process.exitCode = executeRouting(mergedOpts(routingCommand));
});

/**
 * Phase 4a: runtime activation evidence. `ingest` appends OTEL skill_activated
 * events to the local JSONL store; `report` joins the static corpus with what
 * actually fired. The report never gates — it is evidence, not a check.
 */
function executeRuntimeIngest(opts: CommonOpts): number {
  if (!opts.otel) {
    process.stderr.write('runtime ingest requires --otel <path>\n');
    return 3;
  }
  const storePath = opts.store ?? DEFAULT_STORE_PATH;
  try {
    const result = ingestOtelFile(opts.otel, storePath);
    if (opts.json) {
      process.stdout.write(
        stringify({
          version: '1',
          tool: { name: 'skill-diag', version: pkg.version },
          ingested: result,
          storePath,
        }),
      );
      return 0;
    }
    if (opts.quiet) return 0;
    const skipped =
      result.skipped > 0
        ? ` (${result.skipped} malformed line${result.skipped === 1 ? '' : 's'} skipped)`
        : '';
    process.stdout.write(
      `ingested ${result.events} activation${result.events === 1 ? '' : 's'} across ${result.sessions} session${result.sessions === 1 ? '' : 's'} from ${opts.otel}${skipped}\nstore: ${storePath}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 3;
  }
}

function executeRuntimeReport(opts: CommonOpts): number {
  const home = opts.home ?? defaultHome();
  const project = opts.project ?? process.cwd();
  const dedupe = resolveDedupeMode(project, { dedupe: opts.dedupe });
  const skills = discoverSkills({ home, project, dedupe, host: opts.host });
  const storePath = opts.store ?? DEFAULT_STORE_PATH;
  const join = analyzeRuntimeJoin(skills, loadRuntimeStore(storePath));
  if (opts.json) {
    process.stdout.write(toRuntimeJson(join, { version: pkg.version, storePath }));
    return 0;
  }
  if (opts.quiet) return 0;
  process.stdout.write(
    renderRuntimeHuman(join, { version: pkg.version, storePath, color: opts.color !== false }),
  );
  return 0;
}

const runtimeCommand = program.command('runtime').description('Runtime activation evidence from OTEL telemetry');
const ingestCommand = runtimeCommand
  .command('ingest')
  .description('Ingest OTEL JSONL activation logs into the local store')
  .option('--otel <path>', 'OTEL JSONL log file to ingest')
  .option('--store <path>', 'runtime store path override (default ~/.cache/skill-diag/runtime.jsonl)');
ingestCommand.action(() => {
  process.exitCode = executeRuntimeIngest(mergedOpts(ingestCommand));
});

const runtimeReportCommand = runtimeCommand
  .command('report')
  .description('Join static skill discovery with runtime activations');
addCommonOptions(runtimeReportCommand);
runtimeReportCommand.action(() => {
  process.exitCode = executeRuntimeReport(mergedOpts(runtimeReportCommand));
});

/**
 * Phase 4b: the MCP server. stdout belongs to the protocol from here on —
 * the report travels inside tool-result text, never as a bare stdout write.
 */
const mcpCommand = program
  .command('mcp')
  .description('Run the stdio MCP server exposing the diagnose_skills tool');
addCommonOptions(mcpCommand);
mcpCommand.action(async () => {
  process.exitCode = await runMcpServer({ ...mergedOpts(mcpCommand), version: pkg.version });
});

const initCommand = program
  .command('init')
  .description('Write .skill-diag.json with the default routing parameters');
initCommand.option('-p, --project <path>', 'project root to write into');
initCommand.action(() => {
  const dir = mergedOpts(initCommand).project ?? process.cwd();
  const result = writeDefaultConfig(dir);
  process.stdout.write(
    result.created ? `wrote ${result.path}\n` : `${result.path} already exists — left unchanged\n`,
  );
});

try {
  program.parse();
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 4;
}

export { computeBudget, resolveContextWindow };
