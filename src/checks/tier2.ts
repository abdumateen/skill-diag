/**
 * Tier 2 checks. `context-pressure` (Phase 1) and the two routing-health
 * warnings (Phase 2b) came first; Phase 3a adds the seven description- and
 * body-hygiene checks the incumbent tool does not run on plugin skills.
 *
 * Everything here is deterministic and offline: token shingles, the filesystem,
 * and regexes over the body. Nothing calls the host, so two runs over one corpus
 * produce byte-identical findings.
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULT_CLUSTER_OPTIONS,
  detectClusters,
  jaccard,
  shingles,
  tokenize,
} from '../model/clusters.js';
import {
  ROUTING_CRITICAL_THRESHOLD,
  ROUTING_WARNING_THRESHOLD,
  type RoutingReport,
} from '../model/routing.js';
import { listingText } from '../parser/skill.js';
import type { Finding, Skill } from '../types.js';
import { displayName } from '../types.js';
import type { Check, CheckContext } from './tier1.js';

function finding(
  checkId: string,
  skill: Skill | null,
  severity: Finding['severity'],
  message: string,
): Finding {
  return {
    checkId,
    tier: 2,
    severity,
    skillPath: skill?.path ?? null,
    skillName: skill ? displayName(skill) : 'routing',
    skillSource: skill?.source ?? null,
    message,
  };
}

/** 1-based file line of `index` inside `skill.body`. */
function lineInBody(skill: Skill, index: number): number {
  let line = skill.bodyStartLine ?? 1;
  for (let i = 0; i < index; i += 1) if (skill.body[i] === '\n') line += 1;
  return line;
}

export const contextPressure: Check = {
  id: 'context-pressure',
  tier: 2,
  run: ({ budget, contextWindow }: CheckContext) => {
    const charsPerToken = 4;
    const tokens = budget.effectiveChars / charsPerToken;
    const pct = contextWindow > 0 ? (tokens / contextWindow) * 100 : 0;
    if (pct <= 80) return [];
    const severity: Finding['severity'] = pct > 95 ? 'error' : 'warning';
    return [
      finding(
        'context-pressure',
        null,
        severity,
        `system prompt estimated at ${Math.round(tokens).toLocaleString('en-US')}/${contextWindow.toLocaleString('en-US')} tokens (${pct.toFixed(1)}%)`,
      ),
    ];
  },
};

/**
 * `routing-health-at-risk` is the warning band, `routing-health-critical` is
 * below it. They are mutually exclusive: a corpus at 0.45 gets the error and not
 * also the warning, because one condition should not produce two findings.
 *
 * One helper feeds both checks and `routing --json`, so the two surfaces cannot
 * disagree about the same estimate.
 *
 * These are model estimates, not facts about a file. Phase 3c: they default to
 * `info` so an estimate never fails a run on its own; `--strict-raw` promotes
 * them to their natural severity (`error`/`warning`), which is also what makes
 * them count toward exit codes.
 */
export function routingHealthFindings(routing: RoutingReport, strictRaw = false): Finding[] {
  if (routing.adjustedTop1 < ROUTING_CRITICAL_THRESHOLD) {
    return [
      finding(
        'routing-health-critical',
        null,
        strictRaw ? 'error' : 'info',
        `estimated top-1 ${routing.adjustedTop1.toFixed(3)} at N_eff=${routing.nEff.toLocaleString('en-US')} is below the ${ROUTING_CRITICAL_THRESHOLD.toFixed(2)} floor; the router is guessing more often than routing`,
      ),
    ];
  }
  if (routing.adjustedTop1 < ROUTING_WARNING_THRESHOLD) {
    return [
      finding(
        'routing-health-at-risk',
        null,
        strictRaw ? 'warning' : 'info',
        `estimated top-1 ${routing.adjustedTop1.toFixed(3)} at N_eff=${routing.nEff.toLocaleString('en-US')} is below the ${ROUTING_WARNING_THRESHOLD.toFixed(2)} warning line; the line is crossed at N ≈ ${routing.breakPoints.warning.nStar.toLocaleString('en-US')}`,
      ),
    ];
  }
  return [];
}

export const routingHealthAtRisk: Check = {
  id: 'routing-health-at-risk',
  tier: 2,
  run: ({ routing, strictRaw }: CheckContext) =>
    routing
      ? routingHealthFindings(routing, strictRaw === true).filter((f) => f.checkId === 'routing-health-at-risk')
      : [],
};

export const routingHealthCritical: Check = {
  id: 'routing-health-critical',
  tier: 2,
  run: ({ routing, strictRaw }: CheckContext) =>
    routing
      ? routingHealthFindings(routing, strictRaw === true).filter((f) => f.checkId === 'routing-health-critical')
      : [],
};

/**
 * Two skills whose listing text is ~the same string compete for the same
 * prompts, so the second copy adds hazard and no capability. Same detector the
 * routing model uses for N_eff, so the warning and the estimate cannot disagree.
 *
 * Lexical by construction — reworded duplicates only. The message says so rather
 * than implying it caught same-meaning-different-words.
 */
export const descriptionCollision: Check = {
  id: 'description-collision',
  tier: 2,
  run: ({ skills }: CheckContext) => {
    const byPath = new Map(skills.map((s) => [s.path, s]));
    const report = detectClusters(
      skills.map((s) => ({
        id: s.path,
        name: displayName(s),
        description: listingText(s),
        plugin: s.plugin ?? null,
      })),
      DEFAULT_CLUSTER_OPTIONS,
    );
    const out: Finding[] = [];
    for (const cluster of report.clusters) {
      for (const id of cluster.members) {
        const skill = byPath.get(id);
        if (!skill) continue;
        const peers = cluster.members.filter((m) => m !== id);
        const best = cluster.pairs
          .filter((p) => p.a === id || p.b === id)
          .reduce((max, p) => Math.max(max, p.similarity), 0);
        const peerNames = peers
          .map((p) => byPath.get(p)?.folderName ?? p)
          .sort()
          .join(', ');
        out.push(
          finding(
            'description-collision',
            skill,
            'warning',
            `listing text is ${(best * 100).toFixed(0)}% identical to ${peers.length === 1 ? '' : `${peers.length} `}other skill${peers.length === 1 ? '' : 's'} (${peerNames}); the router sends those prompts to whichever of them wins the tie`,
          ),
        );
      }
    }
    return out;
  },
};

/** Sentences in the listing text that claim a trigger. */
const TRIGGER_CLAUSE =
  /(?:^|[.;!?]\s+|\n)\s*((?:use (?:this |it )?(?:when|whenever|if|for|to)\b|trigger(?:s|ed)?\b|when (?:the )?user\b|when you need\b)[^.;!?\n]*)/gi;

/** Trigger clauses a skill claims in its description or `when_to_use`. */
export function triggerClauses(skill: Skill): string[] {
  // Joined with a newline rather than through `listingText`, which concatenates
  // the two fields with no separator: a `when_to_use` immediately after a
  // description ending in `.` would otherwise sit on no clause boundary at all.
  const d = skill.frontmatter['description'];
  const w = skill.frontmatter['when_to_use'];
  const text = `${typeof d === 'string' ? d : ''}\n${typeof w === 'string' ? w : ''}`;
  const out: string[] = [];
  for (const match of text.matchAll(TRIGGER_CLAUSE)) {
    const clause = match[1]?.trim();
    if (clause) out.push(clause);
  }
  return out;
}

const TRIGGER_MIN_TOKENS = 4;

/**
 * Two skills that claim the same trigger in near-identical words. Distinct from
 * `description-collision` because the rest of the description can differ freely:
 * this fires on the claim, not on the pitch.
 */
export const triggerOverlap: Check = {
  id: 'trigger-overlap',
  tier: 2,
  run: ({ skills }: CheckContext) => {
    const claims = skills
      .map((skill) => {
        const tokens = tokenize(triggerClauses(skill).join(' '));
        return { skill, size: tokens.length, set: shingles(tokens, 2) };
      })
      .filter((entry) => entry.size >= TRIGGER_MIN_TOKENS);

    const out: Finding[] = [];
    for (let i = 0; i < claims.length; i += 1) {
      const left = claims[i];
      if (!left) continue;
      const overlaps: Array<{ name: string; similarity: number }> = [];
      for (let j = 0; j < claims.length; j += 1) {
        if (i === j) continue;
        const right = claims[j];
        if (!right) continue;
        const similarity = jaccard(left.set, right.set);
        if (similarity >= DEFAULT_CLUSTER_OPTIONS.threshold) {
          overlaps.push({ name: right.skill.folderName, similarity });
        }
      }
      if (overlaps.length === 0) continue;
      overlaps.sort((a, b) => b.similarity - a.similarity || a.name.localeCompare(b.name));
      const best = overlaps[0] as { name: string; similarity: number };
      out.push(
        finding(
          'trigger-overlap',
          left.skill,
          'warning',
          `trigger clause is ${(best.similarity * 100).toFixed(0)}% identical to ${overlaps.length === 1 ? '' : `${overlaps.length} `}other skill${overlaps.length === 1 ? '' : 's'} (${overlaps.map((o) => o.name).join(', ')}); both fire on the same prompt`,
        ),
      );
    }
    return out;
  },
};

/** Tool names the host exposes; a body that names one is asking for it. */
const TOOL_REFERENCE =
  /\b(Bash|Read|Write|Edit|MultiEdit|NotebookEdit|Grep|Glob|WebFetch|WebSearch|Task|TodoWrite|SlashCommand|KillShell|BashOutput)\b/g;

function declaredTools(value: unknown): string[] | null {
  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return null;
}

/** `Bash(git:*)` grants Bash; an argument filter is not a different tool. */
function toolName(entry: string): string {
  const paren = entry.indexOf('(');
  return (paren === -1 ? entry : entry.slice(0, paren)).trim();
}

/**
 * The body tells the agent to run a tool the declaration withholds. Only fires
 * when `allowed-tools` is declared at all — no declaration is not a mismatch,
 * it is no declaration, and inventing one would be a different check.
 */
export const allowedToolsMismatch: Check = {
  id: 'allowed-tools-mismatch',
  tier: 2,
  run: ({ skills }: CheckContext) => {
    const out: Finding[] = [];
    for (const skill of skills) {
      if (skill.yamlError) continue;
      const declared = declaredTools(skill.frontmatter['allowed-tools']);
      if (declared === null) continue;
      const granted = new Set(declared.map(toolName));
      const hits = [...skill.body.matchAll(TOOL_REFERENCE)];
      const missing = [...new Set(hits.map((m) => m[1] as string))]
        .filter((tool) => !granted.has(tool))
        .sort();
      if (missing.length === 0) continue;
      const first = hits.find((m) => m[1] === missing[0]);
      out.push({
        ...finding(
          'allowed-tools-mismatch',
          skill,
          'warning',
          `body calls ${missing.join(', ')} but allowed-tools declares only ${declared.join(', ')}; those calls are refused at runtime`,
        ),
        ...(first?.index !== undefined ? { line: lineInBody(skill, first.index) } : {}),
      });
    }
    return out;
  },
};

/** The host reads a body as instructions, not as a document. */
export const BODY_MAX_CHARS = 5000;

export const bodyOversized: Check = {
  id: 'body-oversized',
  tier: 2,
  run: ({ skills }: CheckContext) => {
    const out: Finding[] = [];
    for (const skill of skills) {
      const len = skill.body.trim().length;
      if (len <= BODY_MAX_CHARS) continue;
      out.push({
        ...finding(
          'body-oversized',
          skill,
          'warning',
          `body is ${len.toLocaleString('en-US')} chars (limit ${BODY_MAX_CHARS.toLocaleString('en-US')}); every activation loads the excess`,
        ),
        line: skill.bodyStartLine ?? 1,
      });
    }
    return out;
  },
};

const MD_LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const CODE_PATH =
  /`([A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:md|markdown|json|ya?ml|toml|txt|sh|bash|ps1|ts|tsx|js|mjs|cjs|py|rb|go|rs|sql|csv))`/g;

/** Schemes, anchors and absolute paths are other checks' business. */
function isLocalReference(ref: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return false; // http:, https:, mailto:
  if (ref.startsWith('#') || ref.startsWith('/')) return false;
  if (/^[A-Za-z]:[\\/]/.test(ref)) return false;
  return true;
}

/**
 * The body points at a file bundled beside SKILL.md that is not there: the
 * agent follows the reference and reads nothing. Relative references only —
 * absolute ones belong to `absolute-path`.
 */
export const referenceMissing: Check = {
  id: 'reference-missing',
  tier: 2,
  run: ({ skills }: CheckContext) => {
    const out: Finding[] = [];
    for (const skill of skills) {
      const dir = dirname(skill.path);
      const seen = new Set<string>();
      const missing: Array<{ ref: string; index: number }> = [];
      for (const pattern of [MD_LINK, CODE_PATH]) {
        for (const match of skill.body.matchAll(pattern)) {
          const ref = match[1];
          if (!ref || seen.has(ref) || !isLocalReference(ref)) continue;
          seen.add(ref);
          if (existsSync(join(dir, ref))) continue;
          missing.push({ ref, index: match.index ?? 0 });
        }
      }
      if (missing.length === 0) continue;
      missing.sort((a, b) => a.index - b.index);
      const first = missing[0] as { ref: string; index: number };
      out.push({
        ...finding(
          'reference-missing',
          skill,
          'warning',
          `body references ${missing.map((m) => m.ref).join(', ')} but ${missing.length === 1 ? 'that path does' : 'those paths do'} not exist next to SKILL.md; the agent reads nothing`,
        ),
        line: lineInBody(skill, first.index),
      });
    }
    return out;
  },
};

const ABSOLUTE_PATH =
  /(?:[A-Za-z]:\\(?:[^\\\s`"')\]]+\\)*[^\\\s`"')\]]+|\/(?:Users|home|tmp|var|opt|etc|mnt|Volumes|root)\/[^\s`"')\]]*)/g;

/**
 * A skill is shared, so a machine-local path in the body is either dead for
 * everyone else or a private detail that should not ship.
 */
export const absolutePath: Check = {
  id: 'absolute-path',
  tier: 2,
  run: ({ skills }: CheckContext) => {
    const out: Finding[] = [];
    for (const skill of skills) {
      const hits = [...skill.body.matchAll(ABSOLUTE_PATH)];
      const first = hits[0];
      if (!first) continue;
      const shown = [...new Set(hits.map((h) => h[0]))].sort();
      out.push({
        ...finding(
          'absolute-path',
          skill,
          'warning',
          `body hard-codes ${hits.length} absolute path${hits.length === 1 ? '' : 's'} (${shown.slice(0, 3).join(', ')}${shown.length > 3 ? ', …' : ''}); the skill is not portable off this machine`,
        ),
        line: lineInBody(skill, first.index ?? 0),
      });
    }
    return out;
  },
};

/** Files the host never reads, but a copied skill folder often ships anyway. */
const DOC_FILES = new Set([
  'readme.md',
  'readme',
  'changelog.md',
  'changelog',
  'contributing.md',
  'contributing',
  'install.md',
  'install',
  'history.md',
]);

/**
 * Docs belong with the repo, not inside the skill folder. They cost nothing in
 * the listing budget, which is why the budget check never sees them — but they
 * ship to every consumer of every install.
 */
export const docsInSkillFolder: Check = {
  id: 'docs-in-skill-folder',
  tier: 2,
  run: ({ skills }: CheckContext) => {
    const out: Finding[] = [];
    for (const skill of skills) {
      let entries: string[];
      try {
        entries = readdirSync(dirname(skill.path));
      } catch {
        continue;
      }
      const docs = entries.filter((name) => DOC_FILES.has(name.toLowerCase())).sort();
      if (docs.length === 0) continue;
      out.push(
        finding(
          'docs-in-skill-folder',
          skill,
          'warning',
          `${docs.join(', ')} ${docs.length === 1 ? 'sits' : 'sit'} inside the skill folder; documentation belongs with the repo, not with every installed copy`,
        ),
      );
    }
    return out;
  },
};

export const TIER2_CHECKS: readonly Check[] = [
  contextPressure,
  routingHealthAtRisk,
  routingHealthCritical,
  descriptionCollision,
  triggerOverlap,
  allowedToolsMismatch,
  bodyOversized,
  referenceMissing,
  absolutePath,
  docsInSkillFolder,
];
