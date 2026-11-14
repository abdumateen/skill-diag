/**
 * Phase 3c cold-start benchmark.
 *
 * A trial is a fresh `node dist/cli.js --json --quiet` process: the CLI does no
 * caching of its own, so process start-up is the honest cold cost, matching how
 * the Phase 2a numbers (544 ms on 100 skills, 3,572 ms on 1,115) were taken.
 *
 * Three corpora, five trials each:
 *   1. a generated 100-skill corpus in a temp dir — the gate (< 1,000 ms median)
 *   2. the 1,115-skill Phase 1 corpus (read-only) — reported
 *   3. the real home (~/.claude) — reported
 *
 * The project root is pinned to an empty temp dir in every run so the repo's
 * own .claude/skills (if any) and .skill-diag.json cannot leak into the numbers.
 * The corpus directory is only ever read.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const CLI = join(process.cwd(), 'dist', 'cli.js');
const TRIALS = 5;
const GATE_MS = 1_000;
const INCUMBENT_1115_MS = 18_300; // claude-skills-doctor v0.7.0 median, docs/PLAN.md

if (!existsSync(CLI)) {
  console.error('dist/cli.js missing — run `npm run build` first');
  process.exit(2);
}

/** A flat corpus of `count` distinct one-skill plugins under .claude/plugins. */
function generateCorpus(count) {
  const home = mkdtempSync(join(tmpdir(), 'skill-diag-bench-'));
  for (let i = 0; i < count; i += 1) {
    const dir = join(home, '.claude', 'plugins', `plug-${i}`, 'skills', `skill-${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: skill-${i}\ndescription: Distinct capability number ${i} that handles workflow ${i % 97} with procedure ${(i * 7) % 1009}\n---\n\nBody.\n`,
      'utf8',
    );
  }
  return home;
}

function emptyProject() {
  return mkdtempSync(join(tmpdir(), 'skill-diag-bench-p-'));
}

/** One cold trial: a fresh process, timed wall-clock, stdout discarded. */
function coldRun(home, project) {
  const start = performance.now();
  const result = spawnSync(process.execPath, [CLI, '--json', '--quiet', '--home', home, '-p', project], {
    stdio: ['ignore', 'ignore', 'pipe'],
    maxBuffer: 4 * 1024 * 1024,
  });
  const ms = performance.now() - start;
  // The exit code is data (the lint's own gate: 1 when error findings exist),
  // not a bench failure — only a spawn-level error kills the trial.
  if (result.error) {
    throw new Error(`cold run could not start: ${result.error}`);
  }
  return ms;
}

function series(label, home, project) {
  const times = [];
  for (let i = 0; i < TRIALS; i += 1) times.push(coldRun(home, project));
  times.sort((a, b) => a - b);
  const median = times[Math.floor(TRIALS / 2)];
  console.log(
    `${label.padEnd(34)} median ${median.toFixed(0).padStart(6)} ms   (min ${times[0].toFixed(0)}, max ${times[TRIALS - 1].toFixed(0)}, n=${TRIALS})`,
  );
  return median;
}

const made = [];
const project = emptyProject();
made.push(project);

try {
  console.log(`skill-diag cold-start benchmark — ${TRIALS} trials per corpus, fresh process each\n`);

  const corpus100 = generateCorpus(100);
  made.push(corpus100);
  const median100 = series('100-skill corpus (generated)', corpus100, project);

  const CORPUS_1115 = join(homedir(), 'AppData/Local/Temp/skill-diag-bl/corpus/home');
  let median1115 = null;
  if (existsSync(CORPUS_1115)) {
    median1115 = series('1,115-skill corpus (Phase 1)', CORPUS_1115, project);
  } else {
    console.log('1,115-skill corpus (Phase 1)      not found — skipped');
  }

  let medianReal = null;
  if (existsSync(join(homedir(), '.claude'))) {
    medianReal = series('real home (~/.claude)', homedir(), project);
  }

  console.log('');
  if (median100 < GATE_MS) {
    console.log(`gate: 100-skill cold median ${median100.toFixed(0)} ms < ${GATE_MS} ms — PASS`);
  } else {
    console.log(`gate: 100-skill cold median ${median100.toFixed(0)} ms >= ${GATE_MS} ms — FAIL`);
    process.exitCode = 1;
  }
  if (median1115 !== null) {
    console.log(
      `vs incumbent (claude-skills-doctor v0.7.0, ${(INCUMBENT_1115_MS / 1000).toFixed(1)} s median on 1,115 skills): ${(INCUMBENT_1115_MS / median1115).toFixed(1)}× faster`,
    );
  }
  if (medianReal !== null) {
    console.log('real-home run is reported, not gated: the corpus is whatever this machine has.');
  }
} finally {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
}
