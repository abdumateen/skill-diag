/**
 * Human output (spec §12.4), minus the lines Phase 1 does not implement:
 * routing health, drop simulation and runtime findings. Printing a routing
 * estimate here would imply a model that does not exist yet.
 */

import pc from 'picocolors';
import type { CorpusReport, Finding } from '../types.js';

const BAR_WIDTH = 32;

function bar(percent: number): string {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((percent / 100) * BAR_WIDTH)));
  return `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`;
}

function severityLabel(f: Finding): string {
  if (f.severity === 'error') return pc.red('ERROR');
  if (f.severity === 'warning') return pc.yellow('WARN ');
  return pc.dim('INFO ');
}

function relative(report: CorpusReport, path: string | null): string {
  if (!path) return '';
  return path;
}

export function renderHuman(
  report: CorpusReport,
  opts: { version: string; color: boolean; exitCode: 0 | 1 | 2 },
): string {
  if (!opts.color) {
    process.env['NO_COLOR'] = '1';
  }
  const lines: string[] = [];
  const b = report.budget;

  lines.push(
    `${pc.bold('skill-diag')} v${opts.version} · host: ${report.host} ${report.hostVersionRange} · context: ${report.contextWindow.toLocaleString('en-US')} tokens`,
  );
  lines.push(
    `Discovery budget ${bar(b.percentUsed)} ${b.effectiveChars.toLocaleString('en-US')} / ${b.limitChars.toLocaleString('en-US')} chars (${b.percentUsed.toFixed(1)}%)`,
  );
  lines.push(
    `effective chars (incl. overhead) ${b.effectiveChars.toLocaleString('en-US')} / ${b.limitChars.toLocaleString('en-US')} (${b.percentUsed.toFixed(1)}%)`,
  );
  lines.push(`raw chars (before per-entry cap) ${b.rawChars.toLocaleString('en-US')}`);
  lines.push(
    `per-entry cap ${b.perEntryCapChars.toLocaleString('en-US')} chars · overhead ${b.overhead.charsPerEntry} chars/entry ${pc.yellow('(uncalibrated — Phase 2)')}`,
  );

  const errors = report.findings.filter((f) => f.severity === 'error').length;
  const warnings = report.findings.filter((f) => f.severity === 'warning').length;

  if (report.findings.length > 0) {
    lines.push('');
    lines.push(pc.bold('FINDINGS (severity-ordered)'));
    for (const f of report.findings) {
      const where = f.skillPath ? `${f.skillPath}${f.line ? `:${f.line}` : ''}` : '(listing)';
      const src = f.skillSource && f.skillSource === 'plugin' ? pc.dim(' [plugin]') : '';
      lines.push(`${severityLabel(f)} ${pc.bold(f.checkId)} ${where}${src}`);
      lines.push(`  ${f.message}`);
      if (f.fix) lines.push(pc.dim(`  fix: ${f.fix.kind} [${f.fix.confidence}]`));
    }
  }

  lines.push('');
  const pluginSkills = report.skills.filter((s) => s.source === 'plugin').length;
  const userSkills = report.skills.length - pluginSkills;
  lines.push(
    `${report.skills.length} skills (${userSkills} user/project, ${pluginSkills} plugin) · 0 commands · ${errors} error${errors === 1 ? '' : 's'} · ${warnings} warning${warnings === 1 ? '' : 's'}`,
  );
  lines.push(`exit ${opts.exitCode}`);
  return lines.join('\n');
}

/** `--why <skill>`: the §18.1 workflow, static half only. */
export function renderWhy(
  report: CorpusReport,
  target: string,
  opts: { color: boolean },
): string {
  if (!opts.color) process.env['NO_COLOR'] = '1';
  const matches = report.skills.filter(
    (s) =>
      s.name === target ||
      s.folderName === target ||
      (s.plugin ? `${s.plugin}:${s.name ?? s.folderName}` === target : false),
  );

  if (matches.length === 0) {
    return `no skill matches ${target}\n`;
  }

  const out: string[] = [];
  for (const skill of matches) {
    const label = skill.plugin ? `${skill.plugin}:${skill.name ?? skill.folderName}` : (skill.name ?? skill.folderName);
    out.push(`${pc.bold(label)}  ${pc.dim(skill.source)} ${skill.path}`);

    const findings = report.findings.filter((f) => f.skillPath === skill.path);
    out.push(
      findings.length === 0
        ? `  ${pc.green('no Tier 1 findings')}`
        : `  ${findings.length} finding${findings.length === 1 ? '' : 's'}:`,
    );
    for (const f of findings) {
      out.push(`    ${severityLabel(f)} ${f.checkId} — ${f.message}`);
      if (f.fix) out.push(pc.dim(`      fix: ${f.fix.kind} [${f.fix.confidence}]`));
    }

    const len = (skill.name ?? skill.folderName).length;
    const desc = typeof skill.frontmatter['description'] === 'string' ? skill.frontmatter['description'] : '';
    const when = typeof skill.frontmatter['when_to_use'] === 'string' ? skill.frontmatter['when_to_use'] : '';
    const cost = len + Math.min(desc.length + when.length, report.budget.perEntryCapChars);
    const share = report.budget.effectiveChars > 0 ? (cost / report.budget.effectiveChars) * 100 : 0;

    out.push(
      `  listing cost: ${cost} chars (${share.toFixed(2)}% of ${report.budget.effectiveChars.toLocaleString('en-US')})`,
    );
    out.push(
      `  budget: ${report.budget.effectiveChars.toLocaleString('en-US')} / ${report.budget.limitChars.toLocaleString('en-US')} chars (${report.budget.percentUsed.toFixed(1)}%)`,
    );
    // Drop simulation is Phase 2: dropOrder is `unknown` in the contract, so the
    // only honest statement is which mechanism would cut this entry.
    const perEntryOver = desc.length + when.length - report.budget.perEntryCapChars;
    out.push(
      perEntryOver > 0
        ? `  ${pc.yellow(`description exceeds the per-entry cap by ${perEntryOver} chars — the tail never reaches the model`)}`
        : `  description fits the per-entry cap (${desc.length + when.length} / ${report.budget.perEntryCapChars})`,
    );
    out.push(
      pc.dim('  drop-set membership: not simulated (drop order unknown until Phase 2)'),
    );
    out.push(pc.dim('  runtime activation: not available (OTEL ingest is v0.2)'));
  }
  return `${out.join('\n')}\n`;
}

export { relative as formatPath };
