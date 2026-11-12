#!/usr/bin/env node
/**
 * §11.2 overhead calibration harness — Phase 2a.
 *
 * Method (reproducible, no host state touched):
 *   1. Build a controlled corpus at %TEMP%/skill-diag-cal/<run>/ with a known
 *      skill count and fixed-length padded descriptions.
 *   2. Set SLASH_COMMAND_TOOL_CHAR_BUDGET to a value that forces the drop
 *      boundary, and run the host headlessly.
 *   3. Move the budget until the first description drops; the delta between the
 *      observed threshold and the raw character sum, divided by entry count, is
 *      `overheadCharsPerEntry`.
 *
 * The user's ~/.claude/skills is never read or written: the corpus lives under
 * the OS temp dir and the host runs with that directory as its project root.
 *
 * If the host cannot run, the harness records WHY and exits non-zero without a
 * number. It never fabricates a measurement.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SKILL_COUNT = 40;
const DESC_LEN = 200;
const ROOT = join(tmpdir(), 'skill-diag-cal');
const RUN = join(ROOT, `run-${Date.now()}`);
const RESULT = join(process.cwd(), 'calibration', 'overhead-result.json');

function buildCorpus() {
  const desc = 'd'.repeat(DESC_LEN);
  let raw = 0;
  for (let i = 0; i < SKILL_COUNT; i += 1) {
    const name = `cal-skill-${String(i).padStart(2, '0')}`;
    const dir = join(RUN, '.claude', 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(dir + '/SKILL.md', `---\nname: ${name}\ndescription: "${desc}"\n---\n\nBody.\n`);
    raw += name.length + DESC_LEN;
  }
  return raw;
}

function hostVersion() {
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 20000 });
  return (r.stdout ?? '').trim().split('\n')[0] ?? '';
}

function runHost(budgetChars) {
  const args = ['-p', 'list the skill names you can see', '--output-format', 'json'];
  const r = spawnSync('claude', args, {
    cwd: RUN,
    encoding: 'utf8',
    timeout: 90000,
    input: '',
    env: { ...process.env, SLASH_COMMAND_TOOL_CHAR_BUDGET: String(budgetChars) },
  });
  return {
    budgetChars,
    exitCode: r.status ?? -1,
    stdout: (r.stdout ?? '').slice(0, 4000),
    stderr: (r.stderr ?? '').slice(0, 2000),
  };
}

const rawChars = buildCorpus();
const attempts = [];

// The boundary we would sweep. Kept explicit so a future run is a git diff, not
// a rewrite: binary-search the first budget at which a description drops.
const rawPerEntry = rawChars / SKILL_COUNT;
for (const slack of [0, Math.round(rawPerEntry / 2), rawPerEntry]) {
  const budget = Math.max(1, rawChars - SKILL_COUNT * slack);
  attempts.push(runHost(budget));
  const failed = attempts[attempts.length - 1].exitCode !== 0;
  if (failed) break; // no point sweeping further: the host is not answering
}

const last = attempts[attempts.length - 1];
const hostFailed = attempts.length > 0 && attempts.every((a) => a.exitCode !== 0);
const reason = hostFailed
  ? `host unavailable at calibration time: \`claude -p\` exited ${last?.exitCode} (${(last?.stderr ?? '').split('\n').find((l) => l.trim().length > 0) ?? 'no stderr'})`
  : 'host ran but the drop boundary could not be observed from the available output';

const result = {
  generatedAt: new Date().toISOString(),
  method: 'calibration/overhead.mjs',
  purpose: 'spec §11.2 — measure overheadCharsPerEntry for the Claude Code listing',
  skillCount: SKILL_COUNT,
  descriptionLength: DESC_LEN,
  rawChars,
  rawCharsPerEntry: rawPerEntry,
  hostVersion: hostVersion(),
  hostAttempted: attempts.length,
  calibrated: false,
  measuredOverheadCharsPerEntry: null,
  reason,
  attempts: attempts.map((a) => ({
    budgetChars: a.budgetChars,
    exitCode: a.exitCode,
    stderrFirstLine: (a.stderr.split('\n').find((l) => l.trim().length > 0) ?? '').slice(0, 300),
  })),
  observationGap:
    'Even on a working host, `--output-format json` does not expose the rendered skill listing; ' +
    'a transcript or debug capture of the system prompt is required to see which descriptions dropped.',
};

writeFileSync(RESULT, JSON.stringify(result, null, 2) + '\n');
// The host may still hold a handle on the temp corpus on Windows; the directory
// is disposable, so a locked cleanup must not turn a recorded result into a crash.
try {
  rmSync(RUN, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
} catch {
  /* leave it under %TEMP%/skill-diag-cal — it is regenerated per run */
}

console.log(JSON.stringify({ calibrated: result.calibrated, reason: result.reason }, null, 2));
process.exit(result.calibrated ? 0 : 2);
