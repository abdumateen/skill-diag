/**
 * Phase 4a: OTEL runtime activation store and the static–runtime join.
 *
 * The store is an append-only JSONL file — the task's sanctioned fallback; no
 * SQLite driver is installed and `node:sqlite` postdates the Node 20 engines
 * target. Two record kinds:
 *
 *   {"kind":"session","id":"...","ts":...}
 *   {"kind":"activation","name":"...","source":"...","trigger":"...","session":"...","ts":...}
 *
 * A session line is written for every distinct session id seen on ANY ingested
 * record — not only skill activations — so sessions where no skill fired still
 * count toward the zero-activation denominator.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_CLUSTER_OPTIONS, detectClusters } from './clusters.js';
import { descriptionOf } from '../parser/skill.js';
import { displayName } from '../types.js';
import type { Skill } from '../types.js';

export const DEFAULT_STORE_PATH = join(homedir(), '.cache', 'skill-diag', 'runtime.jsonl');

/** A zero-activation flag needs at least this many observed sessions. */
export const MIN_SESSIONS = 20;

export interface RuntimeActivation {
  readonly name: string;
  readonly source: string | null;
  readonly trigger: string | null;
  readonly session: string | null;
  readonly ts: number | null;
}

export interface RuntimeStore {
  readonly activations: readonly RuntimeActivation[];
  readonly sessions: readonly string[];
}

export interface IngestResult {
  /** skill_activated events appended to the store. */
  readonly events: number;
  /** Distinct session ids seen in the ingested file. */
  readonly sessions: number;
  /** Lines that were not parseable JSON objects. */
  readonly skipped: number;
}

interface OtelExtract {
  readonly session: string | null;
  readonly skill: {
    readonly name: string;
    readonly source: string | null;
    readonly trigger: string | null;
  } | null;
}

const SKILL_EVENT = 'claude_code.skill_activated';

function firstString(values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function recordObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Extract the session id and, when the record is a skill_activated event, the
 * skill fields. Accepts the OTEL log-record shape (attributes with dotted
 * keys) plus top-level and nested-`skill` fallbacks, because exporters vary.
 * Non-skill records still yield their session id.
 */
export function parseOtelRecord(record: unknown): OtelExtract | null {
  const rec = recordObject(record);
  if (rec === null) return null;
  const attrs = recordObject(rec['attributes']) ?? {};

  const session = firstString([
    attrs['session.id'],
    attrs['session_id'],
    rec['session_id'],
    rec['sessionId'],
  ]);

  const isSkillEvent = [attrs['event.name'], rec['body'], rec['name'], rec['event']].some(
    (value) => typeof value === 'string' && (value as string).includes(SKILL_EVENT),
  );
  if (!isSkillEvent) return { session, skill: null };

  const nested = recordObject(rec['skill']) ?? {};
  const name = firstString([
    attrs['skill.name'],
    attrs['skill_name'],
    rec['skill_name'],
    nested['name'],
  ]);
  if (name === null) return { session, skill: null };
  const source = firstString([
    attrs['skill.source'],
    attrs['skill_source'],
    rec['skill_source'],
    nested['source'],
  ]);
  const trigger = firstString([
    attrs['invocation_trigger'],
    rec['invocation_trigger'],
    nested['invocation_trigger'],
    nested['trigger'],
  ]);
  return { session, skill: { name, source, trigger } };
}

function tsOf(record: unknown): number | null {
  const rec = recordObject(record);
  if (rec === null) return null;
  for (const key of ['ts', 'timestamp', 'timeUnixNano']) {
    const value = rec[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

interface StoreRecord {
  readonly kind: 'session' | 'activation';
  readonly id?: string;
  readonly name?: string;
  readonly source?: string | null;
  readonly trigger?: string | null;
  readonly session?: string | null;
  readonly ts?: number | null;
}

function appendRecord(storePath: string, record: StoreRecord): void {
  mkdirSync(dirname(storePath), { recursive: true });
  appendFileSync(storePath, `${JSON.stringify(record)}\n`, 'utf8');
}

/** Ingest one OTEL JSONL file into the append-only store. */
export function ingestOtelFile(file: string, storePath: string = DEFAULT_STORE_PATH): IngestResult {
  const raw = readFileSync(file, 'utf8');
  const seenSessions = new Set<string>();
  let events = 0;
  let skipped = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue;
    }
    const extracted = parseOtelRecord(parsed);
    if (extracted === null) {
      skipped += 1;
      continue;
    }
    const ts = tsOf(parsed);
    if (extracted.session !== null && !seenSessions.has(extracted.session)) {
      seenSessions.add(extracted.session);
      appendRecord(storePath, { kind: 'session', id: extracted.session, ts });
    }
    if (extracted.skill !== null) {
      events += 1;
      appendRecord(storePath, {
        kind: 'activation',
        name: extracted.skill.name,
        source: extracted.skill.source,
        trigger: extracted.skill.trigger,
        session: extracted.session,
        ts,
      });
    }
  }
  return { events, sessions: seenSessions.size, skipped };
}

/** Read the store; a missing file is an empty store, not an error. */
export function loadRuntimeStore(storePath: string = DEFAULT_STORE_PATH): RuntimeStore {
  if (!existsSync(storePath)) return { activations: [], sessions: [] };
  const raw = readFileSync(storePath, 'utf8');
  const sessions = new Set<string>();
  const seenActivations = new Set<string>();
  const activations: RuntimeActivation[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const rec = recordObject(parsed);
    if (rec === null) continue;
    if (rec['kind'] === 'session' && typeof rec['id'] === 'string' && rec['id'].length > 0) {
      sessions.add(rec['id']);
      continue;
    }
    if (rec['kind'] === 'activation' && typeof rec['name'] === 'string' && rec['name'].length > 0) {
      const activation: RuntimeActivation = {
        name: rec['name'],
        source: typeof rec['source'] === 'string' ? rec['source'] : null,
        trigger: typeof rec['trigger'] === 'string' ? rec['trigger'] : null,
        session: typeof rec['session'] === 'string' ? rec['session'] : null,
        ts: typeof rec['ts'] === 'number' ? rec['ts'] : null,
      };
      // Re-ingesting the same file appends duplicate lines; identity dedupe
      // keeps counts stable across repeated ingests.
      const identity = JSON.stringify([
        activation.name,
        activation.session,
        activation.ts,
        activation.trigger,
      ]);
      if (!seenActivations.has(identity)) {
        seenActivations.add(identity);
        activations.push(activation);
      }
    }
  }
  return { activations, sessions: [...sessions] };
}

export interface SkillRuntime {
  readonly name: string;
  readonly path: string;
  readonly source: Skill['source'];
  readonly plugin: string | null;
  readonly activations: number;
  readonly zeroActivation: boolean;
  readonly theftSuspect: boolean;
  readonly thiefNeighbor: { readonly name: string; readonly activations: number } | null;
}

export interface RuntimeJoin {
  readonly sessions: number;
  readonly observedSkills: readonly string[];
  readonly skills: readonly SkillRuntime[];
  readonly zeroActivation: readonly string[];
  readonly theftSuspects: readonly string[];
  readonly topFiring: readonly { readonly name: string; readonly activations: number }[];
}

/**
 * Join the static skill corpus with runtime activations. Runtime-only skills
 * (present in the store but not discovered statically) appear in the counts
 * and top-firing list but get no per-skill row — the join is static-keyed.
 */
export function analyzeRuntimeJoin(skills: readonly Skill[], store: RuntimeStore): RuntimeJoin {
  const counts = new Map<string, number>();
  for (const activation of store.activations) {
    counts.set(activation.name, (counts.get(activation.name) ?? 0) + 1);
  }
  const clusters = detectClusters(
    skills.map((skill) => ({
      id: skill.path,
      name: displayName(skill),
      description: descriptionOf(skill),
      plugin: skill.plugin ?? null,
    })),
    DEFAULT_CLUSTER_OPTIONS,
  );
  const clusterOf = new Map<string, readonly string[]>();
  for (const cluster of clusters.clusters) {
    for (const id of cluster.members) clusterOf.set(id, cluster.members);
  }

  const gated = store.sessions.length >= MIN_SESSIONS;
  const rows = skills.map((skill): SkillRuntime => {
    const name = displayName(skill);
    const activations = counts.get(name) ?? 0;
    const zeroActivation = gated && activations === 0;
    let theftSuspect = false;
    let thiefNeighbor: { name: string; activations: number } | null = null;
    if (zeroActivation) {
      const members = clusterOf.get(skill.path);
      if (members !== undefined) {
        for (const memberId of members) {
          if (memberId === skill.path) continue;
          const neighbor = skills.find((candidate) => candidate.path === memberId);
          if (neighbor === undefined) continue;
          const neighborName = displayName(neighbor);
          const neighborActivations = counts.get(neighborName) ?? 0;
          if (
            neighborActivations > 0 &&
            (thiefNeighbor === null || neighborActivations > thiefNeighbor.activations)
          ) {
            theftSuspect = true;
            thiefNeighbor = { name: neighborName, activations: neighborActivations };
          }
        }
      }
    }
    return {
      name,
      path: skill.path,
      source: skill.source,
      plugin: skill.plugin ?? null,
      activations,
      zeroActivation,
      theftSuspect,
      thiefNeighbor,
    };
  });

  const topFiring = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([name, activations]) => ({ name, activations }));

  return {
    sessions: store.sessions.length,
    observedSkills: [...counts.keys()].sort(),
    skills: rows,
    zeroActivation: rows.filter((row) => row.zeroActivation).map((row) => row.name).sort(),
    theftSuspects: rows.filter((row) => row.theftSuspect).map((row) => row.name).sort(),
    topFiring,
  };
}

/** The `--why` runtime slice for one skill: null when the store is empty. */
export interface WhyRuntime {
  readonly sessions: number;
  readonly activations: number;
  readonly thiefNeighbor: { readonly name: string; readonly activations: number } | null;
}

export function whyRuntimeFor(
  skills: readonly Skill[],
  target: Skill,
  store: RuntimeStore,
): WhyRuntime | null {
  if (store.sessions.length === 0) return null;
  const join = analyzeRuntimeJoin(skills, store);
  const row = join.skills.find((candidate) => candidate.path === target.path);
  if (row === undefined) return null;
  return {
    sessions: join.sessions,
    activations: row.activations,
    thiefNeighbor: row.thiefNeighbor
      ? { name: row.thiefNeighbor.name, activations: row.thiefNeighbor.activations }
      : null,
  };
}
