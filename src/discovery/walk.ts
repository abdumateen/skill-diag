/**
 * Discovery (Layer 0). Filesystem only — no host API, no network.
 *
 * The plugin rule is deliberately the host's rule: a SKILL.md counts when it sits
 * at `<something>/skills/<name>/SKILL.md`. Anything else inside a plugin checkout
 * (docs, examples, reference files named SKILL.md) is not a registered skill, and
 * counting it would overstate the library the router sees.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseSkillFile } from '../parser/skill.js';
import type { Skill, SkillSource } from '../types.js';

export interface DiscoverOptions {
  /** Home directory override; `~/.claude/skills` and plugins are read from here. */
  home?: string;
  /** Project root; `.claude/skills` is read from here. */
  project?: string;
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
function pluginSkillsIn(pluginsRoot: string): Array<{ file: string; plugin: string }> {
  if (!isDir(pluginsRoot)) return [];
  const out: Array<{ file: string; plugin: string }> = [];
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
        out.push({ file: full, plugin: rel[0] ?? 'unknown' });
      }
    }
  };
  walk(pluginsRoot, 0);
  return out.sort((a, b) => a.file.localeCompare(b.file));
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

export function discoverSkills(options: DiscoverOptions = {}): Skill[] {
  const home = resolve(options.home ?? defaultHome());
  const project = resolve(options.project ?? process.cwd());
  const claude = join(home, '.claude');

  const found: Skill[] = [];
  const seen = new Set<string>();

  const add = (file: string, source: SkillSource, plugin?: string): void => {
    const key = resolve(file);
    if (seen.has(key)) return;
    seen.add(key);
    const text = read(key);
    const skill = parseSkillFile({ path: key, text, source, ...(plugin ? { plugin } : {}) });
    found.push(skill);
  };

  // User skills: ~/.claude/skills/<name>/SKILL.md
  for (const file of skillsIn(join(claude, 'skills'))) add(file, 'user');

  // Project skills: <project>/.claude/skills/<name>/SKILL.md
  for (const file of skillsIn(join(project, '.claude', 'skills'))) add(file, 'project');

  // Plugin skills: ~/.claude/plugins/**/skills/<name>/SKILL.md
  for (const { file, plugin } of pluginSkillsIn(join(claude, 'plugins'))) add(file, 'plugin', plugin);

  return found;
}

export { basename };
