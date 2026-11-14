/**
 * Discovery (Layer 0). Filesystem only — no host API, no network.
 *
 * The plugin rule is deliberately the host's rule: a SKILL.md counts when it sits
 * at `<something>/skills/<name>/SKILL.md`. Anything else inside a plugin checkout
 * (docs, examples, reference files named SKILL.md) is not a registered skill, and
 * counting it would overstate the library the router sees.
 *
 * Dedupe (Phase 2c.3). A host install keeps every cached plugin version and a
 * marketplace checkout, so the same skill can appear many times on disk while
 * the host loads exactly one copy. `enabled-latest` keeps skills from enabled
 * plugins at the newest cached version, and drops marketplace copies whose
 * content already came from the cache. `all` (and its alias `off`) keeps the
 * raw every-SKILL.md-on-disk scan.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseSkillFile } from '../parser/skill.js';
import type { Skill, SkillSource } from '../types.js';

export type DedupeMode = 'enabled-latest' | 'all' | 'off';

export interface DedupeReport {
  mode: DedupeMode;
  /** Where the enabled-plugin list came from, or why the heuristic ran. */
  source: string;
  pluginsEnabled: number | null;
  pluginSkillsBefore: number;
  pluginSkillsAfter: number;
  removed: {
    disabledPlugins: number;
    oldVersions: number;
    marketplaceCopies: number;
    duplicateContent: number;
  };
}

export interface DiscoverOptions {
  /** Home directory override; `~/.claude/skills` and plugins are read from here. */
  home?: string;
  /** Project root; `.claude/skills` is read from here. */
  project?: string;
  /** Discovery dedupe mode; defaults to `enabled-latest`. */
  dedupe?: DedupeMode;
}

export interface PluginEntry {
  file: string;
  plugin: string;
  marketplace: string | null;
  version: string | null;
  /** True when the file came from `plugins/cache/`. */
  cached: boolean;
}

export function defaultHome(): string {
  return process.env['SKILL_DIAG_HOME'] ?? homedir();
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Skill dirs are one level under a `skills` root: `skills/<name>/SKILL.md`. */
function skillsIn(root: string): string[] {
  if (!isDir(root)) return [];
  const out: string[] = [];
  for (const entry of safeReaddir(root)) {
    const file = join(root, entry.name, 'SKILL.md');
    if (isFile(file)) out.push(file);
  }
  return out.sort();
}

/**
 * Plugin skills live arbitrarily deep inside a plugin checkout, but always at
 * `.../skills/<name>/SKILL.md`. Walk once and keep only those.
 */
function pluginSkillsIn(pluginsRoot: string): PluginEntry[] {
  if (!isDir(pluginsRoot)) return [];
  const out: PluginEntry[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 12) return;
    for (const entry of safeReaddir(dir)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        // Require the shape .../skills/<name>/SKILL.md: the `skills` segment sits
        // three from the end (SKILL.md, <name>, skills).
        const segments = resolve(full).split(/[\\/]/);
        const idx = segments.lastIndexOf('skills');
        if (idx === -1 || idx !== segments.length - 3) continue;
        const rel = resolve(full).slice(pluginsRoot.length).split(/[\\/]/).filter(Boolean);
        out.push({ file: full, ...pluginIdentity(rel) });
      }
    }
  };
  walk(pluginsRoot, 0);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

export function pluginIdentity(rel: string[]): Omit<PluginEntry, 'file'> {
  if (rel[0] === 'cache' && rel.length >= 4) {
    return {
      marketplace: rel[1] ?? null,
      plugin: rel[2] ?? 'unknown',
      // `cache/<marketplace>/<plugin>/<version>/...`; a missing version dir is
      // treated as the only version.
      version: rel[3] === 'skills' || rel[3] === undefined ? null : rel[3],
      cached: true,
    };
  }
  if (rel[0] === 'marketplaces' && rel.length >= 2) {
    // The directory directly above `skills` names the plugin; when the checkout
    // root owns `skills`, the marketplace name is the plugin.
    const idx = rel.lastIndexOf('skills');
    const before = idx > 0 ? rel[idx - 1] : rel[1];
    return {
      marketplace: rel[1] ?? null,
      plugin: before ?? rel[1] ?? 'unknown',
      version: null,
      cached: false,
    };
  }
  // Corpus snapshots are flat: `plugins/<dir>/skills/<name>/SKILL.md`.
  return { marketplace: null, plugin: rel[0] ?? 'unknown', version: null, cached: false };
}

function safeReaddir(dir: string): Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/** `enabledPlugins` keys are `plugin@marketplace`; later files override earlier. */
export function readEnabledPlugins(home: string): { plugins: Set<string> | null; source: string } {
  const claude = join(home, '.claude');
  const merged = new Map<string, boolean>();
  let source: string | null = null;
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = join(claude, name);
    if (!isFile(file)) continue;
    try {
      const parsed = JSON.parse(read(file)) as { enabledPlugins?: Record<string, unknown> };
      const map = parsed.enabledPlugins;
      if (!map || typeof map !== 'object') continue;
      for (const [key, value] of Object.entries(map)) merged.set(key, value === true);
      source = name;
    } catch {
      continue;
    }
  }
  if (source === null) return { plugins: null, source: 'heuristic, settings unreadable' };
  const plugins = new Set([...merged].filter(([, on]) => on).map(([key]) => key));
  if (plugins.size === 0) return { plugins: null, source: 'heuristic, settings unreadable' };
  return { plugins, source };
}

function enabled(entry: PluginEntry, plugins: Set<string>): boolean {
  if (plugins.has(`${entry.plugin}@${entry.marketplace ?? ''}`)) return true;
  // A settings key without a marketplace suffix still enables the plugin.
  return [...plugins].some((key) => key.split('@')[0] === entry.plugin);
}

function compareVersions(a: string | null, b: string | null): number {
  return (a ?? '').localeCompare(b ?? '', undefined, { numeric: true });
}

/** Newest version per cached plugin; version-less roots are kept as-is. */
function latestVersions(entries: PluginEntry[]): { kept: PluginEntry[]; dropped: number } {
  const newest = new Map<string, string | null>();
  for (const entry of entries) {
    if (!entry.cached) continue;
    const key = `${entry.marketplace ?? ''}\0${entry.plugin}`;
    const current = newest.get(key);
    if (current === undefined || compareVersions(entry.version, current) > 0) {
      newest.set(key, entry.version);
    }
  }
  let dropped = 0;
  const kept = entries.filter((entry) => {
    if (!entry.cached) return true;
    const key = `${entry.marketplace ?? ''}\0${entry.plugin}`;
    if (newest.get(key) === entry.version) return true;
    dropped += 1;
    return false;
  });
  return { kept, dropped };
}

function sha1(file: string): string {
  return createHash('sha1').update(read(file)).digest('hex');
}

/**
 * Apply the discovery dedupe mode. `marketplaceCopies` are dropped by install
 * identity (same marketplace/plugin already served from the cache); any
 * remaining marketplace skill whose content is byte-identical to a kept skill is
 * dropped by SHA-1.
 */
export function dedupePluginEntries(
  entries: PluginEntry[],
  mode: DedupeMode,
  home: string,
): { kept: PluginEntry[]; report: DedupeReport } {
  const base: DedupeReport = {
    mode,
    source: mode === 'all' || mode === 'off' ? 'disabled' : 'settings.json',
    pluginsEnabled: null,
    pluginSkillsBefore: entries.length,
    pluginSkillsAfter: entries.length,
    removed: { disabledPlugins: 0, oldVersions: 0, marketplaceCopies: 0, duplicateContent: 0 },
  };
  if (mode === 'all' || mode === 'off') return { kept: entries, report: base };

  const { plugins, source } = readEnabledPlugins(home);
  const latest = latestVersions(entries);
  let kept = latest.kept;
  const removed = { ...base.removed, oldVersions: latest.dropped };

  if (plugins !== null) {
    const before = kept.length;
    kept = kept.filter((entry) => enabled(entry, plugins));
    removed.disabledPlugins = before - kept.length;
  }

  const cachedPlugins = new Set(
    kept.filter((entry) => entry.cached).map((entry) => `${entry.marketplace ?? ''}\0${entry.plugin}`),
  );
  const hashes = new Set<string>();
  const direct: PluginEntry[] = [];
  const marketplaces: PluginEntry[] = [];
  for (const entry of kept) {
    // Split by origin. Cached entries also carry a marketplace name, so testing
    // that field alone sent every cached skill down the marketplace branch and
    // the identity rule then dropped it. Flat corpus snapshots have no
    // marketplace and are passed through untouched.
    if (entry.cached) {
      direct.push(entry);
      hashes.add(sha1(entry.file));
    } else if (entry.marketplace !== null) {
      marketplaces.push(entry);
    } else {
      direct.push(entry);
    }
  }
  const marketplaceKept: PluginEntry[] = [];
  for (const entry of marketplaces) {
    const key = `${entry.marketplace ?? ''}\0${entry.plugin}`;
    if (cachedPlugins.has(key)) {
      removed.marketplaceCopies += 1;
      continue;
    }
    const hash = sha1(entry.file);
    if (hashes.has(hash)) {
      removed.duplicateContent += 1;
      continue;
    }
    hashes.add(hash);
    marketplaceKept.push(entry);
  }

  kept = [...direct, ...marketplaceKept].sort((a, b) => a.file.localeCompare(b.file));
  return {
    kept,
    report: {
      ...base,
      source,
      pluginsEnabled: plugins === null ? null : plugins.size,
      pluginSkillsAfter: kept.length,
      removed,
    },
  };
}

export function discoverSkillsDetailed(options: DiscoverOptions = {}): {
  skills: Skill[];
  dedupe: DedupeReport;
} {
  const home = resolve(options.home ?? defaultHome());
  const project = resolve(options.project ?? process.cwd());
  const claude = join(home, '.claude');
  const mode = options.dedupe ?? 'enabled-latest';

  const found: Skill[] = [];
  const seen = new Set<string>();

  const add = (file: string, source: SkillSource, plugin?: string): void => {
    const key = resolve(file);
    if (seen.has(key)) return;
    seen.add(key);
    const skill = parseSkillFile({ path: key, text: read(key), source, ...(plugin ? { plugin } : {}) });
    found.push(skill);
  };

  // User skills: ~/.claude/skills/<name>/SKILL.md
  for (const file of skillsIn(join(claude, 'skills'))) add(file, 'user');

  // Project skills: <project>/.claude/skills/<name>/SKILL.md
  for (const file of skillsIn(join(project, '.claude', 'skills'))) add(file, 'project');

  // Plugin skills: ~/.claude/plugins/**/skills/<name>/SKILL.md
  const { kept, report } = dedupePluginEntries(
    pluginSkillsIn(join(claude, 'plugins')),
    mode,
    home,
  );
  for (const entry of kept) add(entry.file, 'plugin', entry.plugin);

  return { skills: found, dedupe: report };
}

export function discoverSkills(options: DiscoverOptions = {}): Skill[] {
  return discoverSkillsDetailed(options).skills;
}

export { basename };