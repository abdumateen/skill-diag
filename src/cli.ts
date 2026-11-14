#!/usr/bin/env node
/**
 * `skill-diag` CLI — Phase 1 surface only.
 *
 * Implemented: default lint (Tier 1 + context-pressure), `budget`, `--why`,
 * `--json`, `--strict`, `--home`, `--project`, `--context-window`, `--budget`.
 * Not implemented on purpose: routing, runtime, MCP, SARIF, --fix, --llm, graph.
 * Those are later phases, and a stub that prints nothing would be worse than no
 * command at all.
 */

import { Command } from 'commander';
import { createRequire } from 'node:module';
import { computeBudget, resolveContextWindow } from './budget.js';
import { runChecks } from './checks/index.js';
import { routingHealthFindings } from './checks/tier2.js';
import { loadContract } from './contracts/loader.js';
import { discoverCommands } from './discovery/commands.js';
import { defaultHome, discoverSkills, discoverSkillsDetailed } from './discovery/walk.js';
import {
  resolveDedupeMode,
  resolveRoutingConfig,
  resolveUploadMode,
  writeDefaultConfig,
} from './model/config.js';
import { analyzeRouting, type RoutingReport } from './model/routing.js';
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
import { matchSkills } from './types.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

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
    .option('--host <host>', 'host contract to use', 'claude-code');
}

function execute(opts: CommonOpts, mode: 'lint' | 'budget'): number {
  const contract = loadContract(opts.host ?? 'claude-code');
  const home = opts.home ?? defaultHome();
  const project = opts.project ?? process.cwd();
  const dedupe = resolveDedupeMode(project, { dedupe: opts.dedupe });
  const skills = discoverSkills({ home, project, dedupe });
  // Commands share the listing budget, so they are discovered and counted even
  // though Phase 1/2a does not lint them.
  const commands = discoverCommands({ home, project, dedupe });

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
  const report = runChecks(skills, {
    contract,
    ...budgetOptions,
    commands,
    routing,
    uploadMode,
  });
  const strict = opts.strict === true;
  const exitCode = exitCodeFor(report, strict);

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
      const raw = discoverSkills({ home, project, dedupe: 'all' });
      if (matchSkills(raw, opts.why).length > 0) {
        process.stdout.write(
          'this skill is a cached older version; it is not in your active skill set.\n',
        );
        return exitCode;
      }
    }
    const dropBehavior = contract.dropBehavior;
    if (opts.json) {
      process.stdout.write(
        stringify(toWhyJson(report, opts.why, { version: pkg.version, dropBehavior })),
      );
      return exitCode;
    }
    process.stdout.write(
      renderWhy(report, opts.why, { color: opts.color !== false, dropBehavior }),
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
program.action(() => {
  process.exitCode = execute(mergedOpts(program), 'lint');
});

const budgetCommand = program.command('budget').description('Show the listing budget and its biggest contributors');
addCommonOptions(budgetCommand);
budgetCommand.action(() => {
  process.exitCode = execute(mergedOpts(budgetCommand), 'budget');
});

const STATUS_RANK: Record<RoutingReport['status'], number> = {
  ok: 0,
  'at-risk': 1,
  critical: 2,
};

function worstStatus(
  a: RoutingReport['status'],
  b: RoutingReport['status'],
): RoutingReport['status'] {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/**
 * `critical` always fails, `at-risk` fails only under `--strict`. The caller
 * passes the worst of the active and raw estimates, so a machine whose raw scan
 * is critical cannot exit 0 just because the deduped scan is healthy.
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

  const active = discoverSkillsDetailed({ home, project, dedupe: mode });
  const report = analyzeRouting(active.skills, config);
  const rawOnly = mode === 'all' || mode === 'off';
  const raw = rawOnly ? null : analyzeRouting(discoverSkills({ home, project, dedupe: 'all' }), config);

  const strict = opts.strict === true;
  const exitCode = routingExitCode(
    raw ? worstStatus(report.status, raw.status) : report.status,
    strict,
  );

  if (opts.why) {
    const target = matchSkills(active.skills, opts.why)[0];
    if (!target) {
      const older = matchSkills(
        rawOnly ? active.skills : discoverSkills({ home, project, dedupe: 'all' }),
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
    if (opts.json) {
      process.stdout.write(
        stringify({
          version: '1',
          tool: { name: 'skill-diag', version: pkg.version },
          ...explainRouting(target, report, mode),
        }),
      );
      return exitCode;
    }
    process.stdout.write(
      renderRoutingWhy(target, report, {
        version: pkg.version,
        color: opts.color !== false,
        mode,
      }),
    );
    return exitCode;
  }

  // The routing subcommand reports both estimates' findings; the main report
  // stays active-only so a deduped install is not alarmed by its own cache.
  const seen = new Set<string>();
  const findings = [
    ...routingHealthFindings(report),
    ...(raw ? routingHealthFindings(raw) : []),
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
