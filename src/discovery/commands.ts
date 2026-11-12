/**
 * Slash-command discovery (Layer 0).
 *
 * Commands are not linted, but they share the discovery budget with skills, so
 * leaving them out makes `effectiveChars` understate what the host actually
 * lists. They are walked from the two roots the contract names:
 * `<project>/.claude/commands/**\/*.md` and `<home>/.claude/commands/**\/*.md`.
 *
 * Naming follows the host: a nested file is namespaced by its directories, so
 * `foo/bar.md` is invoked as `/foo:bar` and costs `foo:bar` in the listing, not
 * `bar`.
 *
 * Plugin commands (`~/.claude/plugins/**\/commands/**\/*.md`) are included too.
 * On the measured machine every one of the 905 commands lives there and
 * `~/.claude/commands` does not exist at all, so omitting plugins would report
 * zero commands and understate the listing by the full command cost. They are
 * namespaced `plugin:command`, which is how the host addresses them.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { PER_ENTRY_CAP } from '../types.js';
import type { SkillSource, SlashCommand } from '../types.js';

export interface CommandDiscoverOptions {
  home: string;
  project: string;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function walkMarkdown(root: string, out: string[]): void {
  if (!isDir(root)) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(full);
  }
}

/** Frontmatter `description`, else the first non-heading body line. */
function commandDescription(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (line.trim() === '---') break;
      const m = /^description:\s*(.*)$/.exec(line);
      if (m?.[1] !== undefined) {
        const v = m[1].trim();
        const unquoted =
          v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")
            ? v.slice(1, -1)
            : v;
        if (unquoted.length > 0) return unquoted;
      }
    }
  }
  for (const line of lines) {
    const s = line.trim();
    if (s && !s.startsWith('#') && s !== '---') return s;
  }
  return '';
}

function commandName(root: string, file: string): string {
  const rel = relative(root, file).split(sep).join('/');
  return rel.replace(/\.md$/i, '').split('/').join(':');
}

/** All `.md` files below a `commands` directory inside a plugin checkout. */
function pluginCommandFiles(pluginsRoot: string): Array<{ file: string; plugin: string; stem: string }> {
  const out: Array<{ file: string; plugin: string; stem: string }> = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 12) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const segments = resolve(full).split(/[\\/]/);
        const idx = segments.lastIndexOf('commands');
        if (idx === -1) continue;
        const pluginIdx = segments.indexOf('plugins');
        if (pluginIdx === -1) continue;
        const plugin = segments[pluginIdx + 1] ?? 'unknown';
        const stem = segments
          .slice(idx + 1)
          .join(':')
          .replace(/\.md$/i, '');
        out.push({ file: full, plugin, stem });
      }
    }
  };
  walk(pluginsRoot, 0);
  return out;
}

export function discoverCommands(options: CommandDiscoverOptions): SlashCommand[] {
  const home = resolve(options.home);
  const project = resolve(options.project);
  const roots: Array<{ root: string; source: SkillSource }> = [
    { root: join(project, '.claude', 'commands'), source: 'project' },
    { root: join(home, '.claude', 'commands'), source: 'user' },
  ];

  const files: Array<{ file: string; source: SkillSource; root: string }> = [];
  for (const { root, source } of roots) {
    const found: string[] = [];
    walkMarkdown(root, found);
    for (const file of found.sort()) files.push({ file, source, root });
  }

  const seen = new Set<string>();
  const commands: SlashCommand[] = [];

  const push = (opts: {
    key: string;
    source: SkillSource;
    name: string;
    stem: string;
    plugin?: string;
  }): void => {
    if (seen.has(opts.key)) return;
    seen.add(opts.key);
    let text = '';
    try {
      text = readFileSync(opts.key, 'utf8');
    } catch {
      text = '';
    }
    const description = commandDescription(text);
    commands.push({
      name: opts.name,
      stem: opts.stem,
      path: opts.key,
      source: opts.source,
      description,
      discoveryCost: opts.name.length + Math.min(description.length, PER_ENTRY_CAP),
      ...(opts.plugin ? { plugin: opts.plugin } : {}),
    });
  };

  for (const { file, source, root } of files) {
    const key = resolve(file);
    const name = commandName(root, key);
    push({ key, source, name, stem: name });
  }

  for (const { file, plugin, stem } of pluginCommandFiles(join(home, '.claude', 'plugins'))) {
    push({ key: resolve(file), source: 'plugin', name: `${plugin}:${stem}`, stem, plugin });
  }

  return commands;
}
