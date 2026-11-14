/**
 * Phase 3c exit-code semantics.
 *
 * Routing-model findings are estimates, not facts about a file: they default to
 * `info` and never fail a run on their own. `--strict-raw` promotes them to
 * their natural severity, at which point they count toward exit codes — the
 * main command through `exitCodeFor`, the `routing` subcommand through its
 * status gate plus the promoted raw estimate.
 *
 * The `routing` subcommand's own exit follows the deduped (active) status only:
 * 0 OK, 2 at-risk under `--strict`, 1 critical. This overrides the interim
 * worst-of behaviour from Phase 2c.3, where a raw critical could fail an
 * otherwise-healthy deduped install.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runChecks } from '../src/checks/index.js';
import { loadContract } from '../src/contracts/loader.js';
import { discoverSkills } from '../src/discovery/walk.js';
import { resolveRoutingConfig, resolveStrictRaw } from '../src/model/config.js';
import { exitCodeFor } from '../src/output/json.js';

const contract = loadContract();

function fixtureReport(fixture: string, strictRaw: boolean) {
  const dir = join(process.cwd(), 'test', 'fixtures', 'tier2', fixture, 'fail');
  return runChecks(discoverSkills({ home: dir, project: dir }), {
    contract,
    routing: resolveRoutingConfig(dir),
    strictRaw,
  });
}

describe('main command: routing estimates do not gate by default', () => {
  it('a raw critical estimate is info and exits 0', () => {
    const report = fixtureReport('routing-health-critical', false);
    expect(
      report.findings.filter((f) => f.checkId === 'routing-health-critical')[0]?.severity,
    ).toBe('info');
    expect(exitCodeFor(report, false)).toBe(0);
    expect(exitCodeFor(report, true)).toBe(0);
  });

  it('under strictRaw the promoted error fails the run', () => {
    const report = fixtureReport('routing-health-critical', true);
    expect(
      report.findings.filter((f) => f.checkId === 'routing-health-critical')[0]?.severity,
    ).toBe('error');
    expect(exitCodeFor(report, false)).toBe(1);
  });

  it('a raw at-risk estimate is info and exits 0; promoted warning gates only under --strict', () => {
    const report = fixtureReport('routing-health-at-risk', false);
    expect(
      report.findings.filter((f) => f.checkId === 'routing-health-at-risk')[0]?.severity,
    ).toBe('info');
    expect(exitCodeFor(report, false)).toBe(0);
    expect(exitCodeFor(report, true)).toBe(0);

    const promoted = fixtureReport('routing-health-at-risk', true);
    expect(exitCodeFor(promoted, false)).toBe(0);
    expect(exitCodeFor(promoted, true)).toBe(2);
  });
});

describe('resolveStrictRaw: flag beats config beats default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-diag-strictraw-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('defaults off, honours the config field, and the flag can only turn it on', () => {
    expect(resolveStrictRaw(dir)).toBe(false);
    writeFileSync(join(dir, '.skill-diag.json'), `${JSON.stringify({ strictRaw: true })}\n`, 'utf8');
    expect(resolveStrictRaw(dir)).toBe(true);
    expect(resolveStrictRaw(dir, { strictRaw: true })).toBe(true);
  });
});

const HOME = homedir();
const hasPlugins = existsSync(join(HOME, '.claude', 'plugins'));

describe.skipIf(!hasPlugins || !existsSync('dist/cli.js'))('routing exit codes on the real home', () => {
  const run = (args: string[]): number => {
    try {
      execFileSync(process.execPath, ['dist/cli.js', 'routing', ...args], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? -1;
    }
  };

  it('exits 0 by default: the deduped estimate is OK and raw findings are info', () => {
    expect(run(['--json', '--home', HOME])).toBe(0);
  });

  it('exits 1 under --strict-raw: the raw scan is critical', () => {
    expect(run(['--json', '--home', HOME, '--strict-raw'])).toBe(1);
  });
});
