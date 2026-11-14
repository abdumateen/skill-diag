/**
 * `routing` output (Phase 2b; dual-N from Phase 2c.3), human and JSON.
 *
 * Both formats print the parameters and their source next to the estimate. A
 * survival number without its provenance invites the reader to treat a published
 * constant as a measurement of their own library.
 *
 * Two N's are reported. The deduped one matches what the host loads when it
 * honours `enabledPlugins`; the raw scan counts every cached plugin version and
 * matches a host that loads the whole cache. Users must know which one is theirs,
 * so both are printed even when only one produced the active finding.
 */

import pc from 'picocolors';
import type { DedupeMode, DedupeReport } from '../discovery/walk.js';
import type { WhyRuntime } from '../model/runtime.js';
import type { RoutingReport } from '../model/routing.js';
import { marginalEffect } from '../model/survival.js';
import { displayName, type Skill } from '../types.js';

export function fmt(n: number, digits = 3): string {
  return n.toFixed(digits);
}

function signed(n: number): string {
  return `${n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en-US')}`;
}

function statusLabel(status: RoutingReport['status']): string {
  if (status === 'critical') return pc.red('CRITICAL (below 0.50)');
  if (status === 'at-risk') return pc.yellow('AT RISK (below 0.60)');
  return pc.green('OK (above 0.60)');
}

function headroomLine(label: string, headroom: number, suffix = ''): string {
  const tail = headroom < 0 ? pc.red(' (already exceeded)') : suffix;
  return `    ${`${label}${suffix}`.padEnd(30)}${signed(headroom)} skills${tail}`;
}

export function renderRoutingHuman(
  report: RoutingReport,
  opts: {
    version: string;
    color: boolean;
    raw?: RoutingReport | null;
    dedupe?: DedupeReport;
  },
): string {
  if (!opts.color) process.env['NO_COLOR'] = '1';
  const lines: string[] = [];
  const p = report.config.params;
  const activeLabel = opts.dedupe && opts.dedupe.mode === 'enabled-latest' ? 'deduped' : 'raw scan';

  lines.push(
    `${pc.bold('skill-diag')} v${opts.version} · routing survival model · r=${p.r} p=${p.p} (${p.source})`,
  );
  lines.push(
    `Routing health    estimated top-1 ${pc.bold(fmt(report.adjustedTop1))}  (${activeLabel} N=${report.n.toLocaleString('en-US')}, N_eff=${report.nEff.toLocaleString('en-US')}, density ${report.density.toFixed(2)})`,
  );
  lines.push(`  naive P_top1(N)        ${fmt(report.naiveTop1)}`);
  if (report.clusters.count === 0) {
    lines.push(
      `  adjusted P_top1(N_eff) ${fmt(report.adjustedTop1)}  ${pc.dim(`(no clusters at threshold ${report.config.similarityThreshold}; adjusted = naive)`)}`,
    );
  } else {
    const delta = report.naiveTop1 - report.adjustedTop1;
    lines.push(
      `  adjusted P_top1(N_eff) ${fmt(report.adjustedTop1)}  ${pc.yellow(`(${report.clusters.count} cluster(s), ${report.clusters.clusteredSkills} skills, −${fmt(delta)})`)}`,
    );
  }

  lines.push(`  current status  ${statusLabel(report.status)} — ${activeLabel}`);
  if (opts.raw) {
    lines.push(`  current status  ${statusLabel(opts.raw.status)} — raw scan`);
  }

  const bp = report.breakPoints;
  lines.push(`  headroom (${activeLabel})`);
  lines.push(`  warning threshold (0.60)`);
  lines.push(headroomLine('naive headroom ', bp.warning.naiveHeadroom));
  lines.push(headroomLine('adjusted headroom ', bp.warning.adjustedHeadroom));
  lines.push(`  break point (0.50)`);
  lines.push(headroomLine('naive headroom ', bp.critical.naiveHeadroom));
  lines.push(headroomLine('adjusted headroom ', bp.critical.adjustedHeadroom));

  if (opts.raw) {
    const rbp = opts.raw.breakPoints;
    lines.push('');
    lines.push(
      `raw-scan cross-check   estimated top-1 ${fmt(opts.raw.adjustedTop1)} (raw N=${opts.raw.n.toLocaleString('en-US')}, N_eff=${opts.raw.nEff.toLocaleString('en-US')})`,
    );
    lines.push(
      `                       ${opts.raw.clusters.count} duplicate clusters, ${opts.raw.clusters.clusteredSkills} skills`,
    );
    lines.push('                       the raw scan counts every cached plugin version as a skill;');
    lines.push('                       if your host loads all cached versions, the raw estimate applies');
    lines.push('  headroom (raw scan)');
    lines.push(`    warning threshold (0.60)    ${signed(rbp.warning.adjustedHeadroom)} skills${rbp.warning.adjustedHeadroom < 0 ? pc.red(' (already exceeded)') : ' (adjusted)'}`);
    lines.push(`    break point (0.50)          ${signed(rbp.critical.adjustedHeadroom)} skills${rbp.critical.adjustedHeadroom < 0 ? pc.red(' (already exceeded)') : ' (adjusted)'}`);
  }

  lines.push('');
  lines.push(pc.bold('Top marginal costs'));
  if (report.marginal.top.length === 0) {
    lines.push('  (no skills)');
  } else {
    lines.push(
      pc.dim(
        `  naive delta per skill is uniform (${fmt(report.marginal.naiveDelta, 6)}) — the model is scale-driven; the adjusted column shows cluster effect`,
      ),
    );
    for (const skill of report.marginal.top) {
      const where = skill.clusterSize > 1 ? pc.dim(` [cluster of ${skill.clusterSize}]`) : '';
      const plugin = skill.plugin ? pc.dim(` ${skill.plugin}`) : '';
      lines.push(
        `  ${fmt(skill.adjustedDelta, 6)}  ${skill.name}${plugin}${where}`,
      );
    }
  }

  lines.push('');
  lines.push(pc.bold('Clusters'));
  if (report.clusters.count === 0) {
    lines.push(`  none at threshold ${report.config.similarityThreshold}`);
  } else {
    const shown = report.clusters.members.slice(0, 12);
    for (const member of shown) {
      lines.push(`  ${member.clusterSize}× ${member.name}${member.plugin ? pc.dim(` ${member.plugin}`) : ''}`);
    }
    if (report.clusters.members.length > shown.length) {
      lines.push(pc.dim(`  ... ${report.clusters.members.length - shown.length} more member(s); use --json for the full list`));
    }
  }
  lines.push(pc.dim(`  ${report.clusters.insufficientNote}`));

  lines.push('');
  lines.push(pc.bold('Mitigation ladder'));
  for (const rung of report.ladder) {
    const gain =
      rung.estimatedGain === null
        ? pc.dim('not simulated')
        : `+${fmt(rung.estimatedGain, 3)} top-1`;
    lines.push(`  ${rung.rung}. ${rung.name.padEnd(18)} ${gain}  ${pc.dim(`[${rung.confidence}]`)}`);
    lines.push(pc.dim(`     ${rung.basis}`));
  }

  lines.push('');
  if (opts.dedupe) {
    const d = opts.dedupe;
    lines.push(
      pc.dim(
        `dedupe: ${d.mode} (${d.source}) · plugin skills ${d.pluginSkillsBefore.toLocaleString('en-US')} → ${d.pluginSkillsAfter.toLocaleString('en-US')} · removed old versions ${d.removed.oldVersions}, disabled plugins ${d.removed.disabledPlugins}, marketplace copies ${d.removed.marketplaceCopies}, duplicate content ${d.removed.duplicateContent}`,
      ),
    );
  }
  lines.push(
    pc.dim(
      `parameters: ${p.source} (${p.citation}) · collisionWeight=${report.config.collisionWeight} · threshold=${report.config.similarityThreshold} · shingle=${report.config.shingleSize}`,
    ),
  );
  return `${lines.join('\n')}\n`;
}

/** The per-skill routing numbers, shared by the human and JSON `--why` paths. */
export function explainRouting(
  skill: Skill,
  report: RoutingReport,
  mode: DedupeMode,
): {
  skill: { name: string; path: string; source: string; plugin?: string };
  mode: DedupeMode;
  marginalTop1Contribution: number;
  clusterMembership: number | null;
  duplicateClusterSize: number | null;
  routingHealthContribution: string;
} {
  const member = report.clusters.members.find((m) => m.id === skill.path);
  const clusterSize = member?.clusterSize ?? 1;
  const rank = report.marginal.top.findIndex((m) => m.path === skill.path);
  return {
    skill: {
      name: displayName(skill),
      path: skill.path,
      source: skill.source,
      ...(skill.plugin ? { plugin: skill.plugin } : {}),
    },
    mode,
    marginalTop1Contribution: Number(
      fmt(
        marginalEffect(report.nEff, report.config.params, clusterSize >= 2 ? 2 : 1),
        6,
      ),
    ),
    clusterMembership: clusterSize >= 2 ? clusterSize : null,
    duplicateClusterSize: clusterSize >= 2 ? clusterSize : null,
    routingHealthContribution:
      rank === -1
        ? 'excluded from top-10'
        : `top-10 rank ${rank + 1} of ${report.marginal.top.length}`,
  };
}

/** `routing --why <skill>`: one skill against the active plan. */
export function renderRoutingWhy(
  skill: Skill,
  report: RoutingReport,
  opts: { version: string; color: boolean; mode: DedupeMode; runtime?: WhyRuntime | null },
): string {
  if (!opts.color) process.env['NO_COLOR'] = '1';
  const why = explainRouting(skill, report, opts.mode);
  const modeLabel = opts.mode === 'enabled-latest' ? 'deduped' : 'raw scan';
  const sourceLabel =
    skill.source === 'plugin'
      ? `plugin${skill.plugin ? ` ${skill.plugin}` : ''}`
      : skill.source;

  const lines = [
    `${pc.bold('skill-diag')} v${opts.version} · routing survival model`,
    `Skill: ${why.skill.name} (${sourceLabel}, ${modeLabel})`,
    `  marginal top-1 contribution   ${fmt(why.marginalTop1Contribution, 6)}`,
    `  cluster membership            ${why.clusterMembership ? `yes (cluster of ${why.clusterMembership})` : 'none'}`,
    `  duplicate cluster size        ${why.duplicateClusterSize ?? 'n/a'}`,
    `  routing health contribution   ${why.routingHealthContribution}`,
  ];
  if (opts.runtime) {
    const rt = opts.runtime;
    lines.push(`  runtime activations           ${rt.activations} in ${rt.sessions} sessions`);
    if (rt.thiefNeighbor) {
      lines.push(
        `  closest firing neighbor       ${rt.thiefNeighbor.name} (${rt.thiefNeighbor.activations} activations)`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export function toRoutingJson(
  report: RoutingReport,
  opts: {
    version: string;
    generatedAt?: string;
    findings?: unknown[];
    dedupe?: DedupeReport;
    raw?: RoutingReport | null;
  },
): unknown {
  const p = report.config.params;
  return {
    version: '1',
    tool: { name: 'skill-diag', version: opts.version },
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    ...(opts.dedupe ? { dedupe: opts.dedupe } : {}),
    ...(opts.findings ? { findings: opts.findings } : {}),
    ...(opts.raw
      ? {
          raw: {
            n: opts.raw.n,
            nEff: opts.raw.nEff,
            naiveTop1: Number(fmt(opts.raw.naiveTop1)),
            adjustedTop1: Number(fmt(opts.raw.adjustedTop1)),
            status: opts.raw.status,
            density: Number(opts.raw.density.toFixed(4)),
            clusters: {
              count: opts.raw.clusters.count,
              clusteredSkills: opts.raw.clusters.clusteredSkills,
            },
            breakPoints: {
              warning: { ...opts.raw.breakPoints.warning },
              critical: { ...opts.raw.breakPoints.critical },
            },
          },
        }
      : {}),
    routing: {
      n: report.n,
      nEff: report.nEff,
      naiveTop1: Number(fmt(report.naiveTop1)),
      adjustedTop1: Number(fmt(report.adjustedTop1)),
      status: report.status,
      parameters: { r: p.r, p: p.p, source: p.source, citation: p.citation },
      collisionWeight: report.config.collisionWeight,
      similarityThreshold: report.config.similarityThreshold,
      shingleSize: report.config.shingleSize,
      minTokens: report.config.minTokens,
      density: Number(report.density.toFixed(4)),
      breakPoints: {
        warning: { ...report.breakPoints.warning },
        critical: { ...report.breakPoints.critical },
      },
      clusters: {
        count: report.clusters.count,
        clusteredSkills: report.clusters.clusteredSkills,
        sizes: report.clusters.sizes,
        insufficient: report.clusters.insufficient,
        members: report.clusters.members.map((m) => ({
          name: m.name,
          path: m.id,
          plugin: m.plugin,
          clusterSize: m.clusterSize,
          descriptionChars: m.descriptionChars,
        })),
        pairs: report.clusters.pairs,
      },
      marginal: {
        naiveDelta: Number(report.marginal.naiveDelta.toFixed(6)),
        shortDescriptionFraction: Number(fmt(report.marginal.shortDescriptionFraction, 4)),
        top: report.marginal.top.map((m) => ({
          name: m.name,
          path: m.path,
          plugin: m.plugin,
          clusterSize: m.clusterSize,
          naiveDelta: Number(m.naiveDelta.toFixed(6)),
          adjustedDelta: Number(m.adjustedDelta.toFixed(6)),
        })),
      },
      mitigation: report.ladder.map((rung) => ({
        rung: rung.rung,
        name: rung.name,
        estimatedGain:
          rung.estimatedGain === null ? null : Number(fmt(rung.estimatedGain, 4)),
        confidence: rung.confidence,
        basis: rung.basis,
      })),
    },
  };
}