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
import { loadContract } from './contracts/loader.js';
import { discoverCommands } from './discovery/commands.js';
import { defaultHome, discoverSkills } from './discovery/walk.js';
import { exitCodeFor, stringify, toJsonReport } from './output/json.js';
import { renderHuman, renderWhy } from './output/human.js';

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
    .option('--host <host>', 'host contract to use', 'claude-code');
}

function execute(opts: CommonOpts, mode: 'lint' | 'budget'): number {
  const contract = loadContract(opts.host ?? 'claude-code');
  const home = opts.home ?? defaultHome();
  const project = opts.project ?? process.cwd();
  const skills = discoverSkills({ home, project });
  // Commands share the listing budget, so they are discovered and counted even
  // though Phase 1/2a does not lint them.
  const commands = discoverCommands({ home, project });

  const budgetOptions = {
    ...(numberOrUndefined(opts.budget) !== undefined
      ? { overrideChars: numberOrUndefined(opts.budget) as number }
      : {}),
    ...(numberOrUndefined(opts.contextWindow) !== undefined
      ? { contextWindow: numberOrUndefined(opts.contextWindow) as number }
      : {}),
  };

  const report = runChecks(skills, { contract, ...budgetOptions, commands });
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
    process.stdout.write(renderWhy(report, opts.why, { color: opts.color !== false }));
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
  process.exitCode = execute(program.opts<CommonOpts>(), 'lint');
});

const budgetCommand = program.command('budget').description('Show the listing budget and its biggest contributors');
addCommonOptions(budgetCommand);
budgetCommand.action(() => {
  process.exitCode = execute(budgetCommand.opts<CommonOpts>(), 'budget');
});

try {
  program.parse();
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 4;
}

export { computeBudget, resolveContextWindow };
