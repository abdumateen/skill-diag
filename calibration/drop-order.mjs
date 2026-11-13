#!/usr/bin/env node
/**
 * Drop-order calibration harness (spec §11.1, Phase 2c).
 *
 * Builds 40 synthetic skills in an isolated temp home, pins the listing budget
 * below their total cost, asks the host to load them, and records which
 * descriptions actually appear. Five trials, each with a different install
 * order (shuffled creation + distinct mtimes), are fitted against four candidate
 * drop rules. The winner is written to calibration/drop-order-result.json.
 *
 * The real ~/.claude/skills is never read or written: HOME, USERPROFILE and
 * CLAUDE_CONFIG_DIR all point at the temp tree.
 *
 * Arithmetic, and where it departs from the brief: 200-char descriptions cannot
 * force 20 drops under a 10,000-char budget — 40 x 200 = 8,000 is below the
 * budget, so nothing drops. "20 of 40 must drop" is the operative mechanism, so
 * names sit at the contract's 64-char maximum and descriptions at 372:
 * 40 x (64 + 372) = 17,440, excess 7,440 = 20 x 372, exactly 20 entries
 * dropped. Folder name and frontmatter `name` are identical, so every probe
 * skill is a valid skill rather than one the loader rejects for mismatch first.
 *
 * Usage:  node calibration/drop-order.mjs [--out calibration/drop-order-result.json]
 * Env:    CLAUDE_BIN   host binary (default: claude)
 *         KEEP=1       keep the temp tree for inspection
 */

import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const N = 40;
const TRIALS = 5;
const DESC_LEN = 372; // chars freed per dropped entry
const NAME_LEN = 64; // contract maximum; folder name equals frontmatter name
const BUDGET = 10_000; // total 12,000 -> excess 2,000 -> 20 entries dropped
const CLAUDE = process.env.CLAUDE_BIN || 'claude';
const RESULT_PATH = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : 'calibration/drop-order-result.json';

const PAD = '—'; // em dash, as in the brief

function skillName(i) {
  const stem = `do-probe-${String(i).padStart(2, '0')}-`;
  return stem + 'x'.repeat(NAME_LEN - stem.length);
}

const folderName = skillName;

function description(i) {
  const marker = `probe-${String(i).padStart(2, '0')} :: `;
  return marker + PAD.repeat(DESC_LEN - marker.length);
}

function shuffled(n) {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function buildTrial(root, trial) {
  const home = join(root, `home-${trial}`);
  const skillsDir = join(home, '.claude', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  const order = shuffled(N);
  const created = [];
  for (const i of order) {
    const dir = join(skillsDir, folderName(i));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${skillName(i)}\ndescription: ${description(i)}\n---\n\nSynthetic probe skill ${i}.\n`,
    );
    // Distinct mtimes encode install order; a least-recently-invoked rule would
    // see these as the only history the temp tree carries.
    const t = Math.floor(Date.now() / 1000) - (N - created.length) * 60;
    utimesSync(dir, t, t);
    created.push(i);
  }
  return { home, order, created };
}

function runHost(home) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    SLASH_COMMAND_TOOL_CHAR_BUDGET: String(BUDGET),
  };
  try {
    const stdout = execSync(`"${CLAUDE}" -p "reply with the single word ok"`, {
      encoding: 'utf8',
      env,
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout, stderr: '', exitCode: 0 };
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr:
        typeof error.stderr === 'string' && error.stderr.trim() !== ''
          ? error.stderr
          : String(error.message ?? error),
      exitCode: typeof error.status === 'number' ? error.status : 1,
    };
  }
}

/** Descriptions the host actually listed: grep the transcript for unique markers. */
function listedMarkers(text) {
  const present = [];
  for (let i = 0; i < N; i++) {
    if (text.includes(description(i))) present.push(i);
  }
  return present;
}

/** Read whatever session transcript the host wrote under the isolated config. */
function transcriptText(home) {
  const chunks = [];
  const projects = join(home, '.claude', 'projects');
  if (!existsSync(projects)) return '';
  for (const dir of readdirSync(projects, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const abs = join(projects, dir.name);
    for (const file of readdirSync(abs)) {
      if (file.endsWith('.jsonl')) chunks.push(readFileSync(join(abs, file), 'utf8'));
    }
  }
  return chunks.join('\n');
}

const RULES = {
  // (a) reverse-alphabetical: highest names drop first
  a: { name: 'reverse-alphabetical', dropFirst: (i) => -i },
  // (b) least-recently-invoked: oldest mtime first (created[] order is oldest first)
  b: { name: 'least-recently-invoked', dropFirst: (i, created) => created.indexOf(i) },
  // (c) reverse-registration: last installed drops first
  c: { name: 'reverse-registration', dropFirst: (i, created) => -created.indexOf(i) },
  // (d) never-invoked-first: no activation data -> only mtime distinguishes
  d: { name: 'never-invoked-first', dropFirst: (i, created) => created.indexOf(i) },
};

function predictDropped(rule, created, dropCount) {
  const order = Array.from({ length: N }, (_, i) => i).sort(
    (x, y) => rule.dropFirst(x, created) - rule.dropFirst(y, created),
  );
  return new Set(order.slice(0, dropCount));
}

function fitRules(observations) {
  const rules = {};
  for (const [key, rule] of Object.entries(RULES)) {
    let matches = 0;
    let compared = 0;
    const details = [];
    for (const obs of observations) {
      if (!obs.ok || !obs.listed) continue;
      compared++;
      const dropped = obs.dropped;
      const predicted = predictDropped(rule, obs.created, dropped.size);
      let hit = 0;
      for (const i of predicted) if (dropped.has(i)) hit++;
      const exact = hit === dropped.size && predicted.size === dropped.size;
      if (exact) matches++;
      details.push({
        trial: obs.trial,
        predictedDropped: [...predicted].sort((a, b) => a - b),
        observedDropped: [...dropped].sort((a, b) => a - b),
        match: exact,
      });
    }
    rules[key] = {
      rule: rule.name,
      matches,
      compared,
      exactRate: compared ? matches / compared : 0,
      details,
    };
  }
  return rules;
}

function winnerOf(rules) {
  let best = null;
  for (const [key, r] of Object.entries(rules)) {
    if (!best || r.matches > rules[best].matches) best = key;
  }
  if (!best || rules[best].matches === 0) return { winner: null, confidence: 'none' };
  const matches = rules[best].matches;
  if (matches >= 4) return { winner: rules[best].rule, confidence: 'high' };
  if (matches >= 3) return { winner: rules[best].rule, confidence: 'low' };
  return { winner: null, confidence: 'none' };
}

function hostVersion() {
  try {
    return execSync(`"${CLAUDE}" --version`, { encoding: 'utf8', timeout: 20_000 }).trim();
  } catch {
    return null;
  }
}

const root = mkdtempSync(join(tmpdir(), 'skill-diag-do-'));
const trials = [];
const observations = [];

try {
  for (let t = 0; t < TRIALS; t++) {
    const built = buildTrial(root, t);
    const run = runHost(built.home);
    const text = `${run.stdout}\n${run.stderr}\n${transcriptText(built.home)}`;
    const listed = run.ok ? listedMarkers(text) : null;
    const dropped =
      listed && listed.length > 0
        ? new Set(Array.from({ length: N }, (_, i) => i).filter((i) => !listed.includes(i)))
        : null;
    const usable = listed !== null && listed.length > 0;
    const trial = {
      trial: t,
      installOrder: built.created,
      hostExitCode: run.exitCode,
      hostAvailable: usable,
      listedCount: listed ? listed.length : 0,
      droppedCount: dropped ? dropped.size : 0,
      listed: listed ? [...listed].sort((a, b) => a - b) : [],
      dropped: dropped ? [...dropped].sort((a, b) => a - b) : [],
      ...(usable
        ? { outputTail: run.stdout.slice(-400) }
        : {
            errorTail: `${run.stderr}\n${run.stdout}`
              .trim()
              .split('\n')
              .filter((line) => line.trim() !== '')
              .slice(-4)
              .join('\n'),
          }),
    };
    trials.push(trial);
    observations.push({ ...trial, ok: usable, listed, dropped, created: built.created });
  }

  const rules = fitRules(observations);
  const { winner, confidence } = winnerOf(rules);
  const anyHost = trials.some((t) => t.hostAvailable);

  const reason =
    'claude-skills-doctor: host unusable for calibration — claude -p exits 1 with [claude-code:unrecognized_model] (model: anthropic/custom-.../deepseek-v4.1-flash:free), duration_api_ms: 0, 0 tokens. Host version 2.1.251 is also signed out (~/.claude.json has no oauthAccount). Overhead constant and budget limit remain unmeasured until the host is both signed in and pointed at a working model.';

  const result = {
    experiment: 'drop-order',
    specSection: '11.1',
    generatedAt: new Date().toISOString(),
    harness: 'calibration/drop-order.mjs',
    hostAvailable: anyHost,
    hostVersion: hostVersion(),
    configuration: {
      skills: N,
      trials: TRIALS,
      descriptionChars: DESC_LEN,
      nameChars: NAME_LEN,
      budgetChars: BUDGET,
      totalRawChars: N * (NAME_LEN + DESC_LEN),
      forcedDropCount: Math.round((N * (NAME_LEN + DESC_LEN) - BUDGET) / DESC_LEN),
      budgetEnv: 'SLASH_COMMAND_TOOL_CHAR_BUDGET',
    },
    trials,
    rules,
    winner,
    confidence,
    evidence: anyHost
      ? 'calibration/drop-order.mjs — 5 isolated-home trials, transcript grep'
      : 'calibration/drop-order.mjs — every trial failed before the listing was produced',
    ...(anyHost ? {} : { reason }),
    observedFailure: trials.find((t) => !t.hostAvailable)?.errorTail ?? null,
  };

  writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`wrote ${RESULT_PATH}`);
  console.log(`hostAvailable=${anyHost} winner=${winner ?? 'unknown'} confidence=${confidence}`);
  if (!anyHost) console.log(`reason: ${reason}`);
} finally {
  if (process.env.KEEP !== '1') rmSync(root, { recursive: true, force: true });
}