/**
 * Phase 7a: routing-health history. One JSON line per `skill-diag snapshot`
 * under <project>/.skill-diag/history.jsonl; the dashboard reads it back as a
 * time series. Append-only on purpose — no rotation, no locking, one writer.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface HistorySnapshot {
  /** ISO 8601 timestamp of when the snapshot was taken. */
  timestamp: string;
  totalSkills: number;
  /** Deduped (N_eff) top-1 routing accuracy — the dashboard's headline figure. */
  routingTop1: number;
  errors: number;
  warnings: number;
}

export const HISTORY_RELATIVE_PATH = join('.skill-diag', 'history.jsonl');

export function historyPath(project: string): string {
  return join(project, HISTORY_RELATIVE_PATH);
}

/** Appends one snapshot line, creating .skill-diag/ on first use. */
export function appendSnapshot(project: string, snapshot: HistorySnapshot): string {
  const file = historyPath(project);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(snapshot)}\n`);
  return file;
}

/** Parsed snapshots; a missing file is an empty history, malformed lines skip. */
export function loadHistory(project: string): HistorySnapshot[] {
  const file = historyPath(project);
  if (!existsSync(file)) return [];
  const snapshots: HistorySnapshot[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as HistorySnapshot;
      if (typeof parsed.timestamp === 'string' && typeof parsed.routingTop1 === 'number') {
        snapshots.push(parsed);
      }
    } catch {
      // a torn write mid-append is one lost point, not a broken dashboard
    }
  }
  return snapshots;
}