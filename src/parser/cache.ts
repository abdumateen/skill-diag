/**
 * Parse cache (spec §4.3).
 *
 * Only parsing is cached. The directory walk always runs, because a new skill
 * cannot be detected without walking — a cached file list would silently miss
 * additions, which is the exact failure this tool exists to catch.
 *
 * Key: (absolutePath, mtimeMs, size). No TTL and no sweeper: an unchanged file
 * keeps its entry forever, a changed one misses once and overwrites. A corrupt
 * entry is deleted and re-parsed silently — a cache must never be a source of
 * user-visible error.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Skill } from '../types.js';

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env['XDG_CACHE_HOME'];
  if (typeof xdg === 'string' && xdg.trim() !== '') return join(xdg, 'skill-diag');
  if (process.platform === 'win32' && typeof env['LOCALAPPDATA'] === 'string' && env['LOCALAPPDATA'] !== '') {
    return join(env['LOCALAPPDATA'], 'skill-diag');
  }
  return join(homedir(), '.cache', 'skill-diag');
}

export interface CacheMeta {
  path: string;
  mtimeMs: number;
  size: number;
}

interface CacheEntry {
  path: string;
  mtimeMs: number;
  size: number;
  skill: Skill;
}

export interface ParseCacheOptions {
  enabled?: boolean;
  dir?: string;
}

export class ParseCache {
  readonly dir: string;
  enabled: boolean;
  hits = 0;
  misses = 0;
  writes = 0;
  private ready = false;

  constructor(options: ParseCacheOptions = {}) {
    this.dir = options.dir ?? defaultCacheDir();
    this.enabled = options.enabled ?? true;
  }

  private file(path: string): string {
    return join(this.dir, `${createHash('sha1').update(path).digest('hex')}.json`);
  }

  private ensureDir(): boolean {
    if (this.ready) return true;
    try {
      mkdirSync(this.dir, { recursive: true });
      this.ready = true;
      return true;
    } catch {
      this.enabled = false;
      return false;
    }
  }

  get(meta: CacheMeta): Skill | null {
    if (!this.enabled) return null;
    const file = this.file(meta.path);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      this.misses += 1;
      return null;
    }
    try {
      const entry = JSON.parse(raw) as CacheEntry;
      if (
        entry.path !== meta.path ||
        entry.mtimeMs !== meta.mtimeMs ||
        entry.size !== meta.size ||
        typeof entry.skill !== 'object' ||
        entry.skill === null
      ) {
        this.misses += 1;
        return null;
      }
      this.hits += 1;
      return entry.skill;
    } catch {
      // Corrupt entry: remove it and let the caller re-parse.
      try {
        unlinkSync(file);
      } catch {
        /* best effort */
      }
      this.misses += 1;
      return null;
    }
  }

  set(meta: CacheMeta, skill: Skill): void {
    if (!this.enabled) return;
    if (!this.ensureDir()) return;
    const entry: CacheEntry = { path: meta.path, mtimeMs: meta.mtimeMs, size: meta.size, skill };
    try {
      writeFileSync(this.file(meta.path), JSON.stringify(entry));
      this.writes += 1;
    } catch {
      /* a failed write only costs a future re-parse */
    }
  }
}
