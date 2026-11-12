/**
 * `routing` output (Phase 2b), human and JSON.
 *
 * Both formats print the parameters and their source next to the estimate. A
 * survival number without its provenance invites the reader to treat a published
 * constant as a measurement of their own library.
 */

import pc from 'picocolors';
import type { RoutingReport } from '../model/routing.js';

export function fmt(n: number, digits = 3): string {
  return n.toFixed(digits);
}

export function renderRoutingHuman(
  report: RoutingReport,
  opts: { version: string; color: boolean },
): string {
  if (!opts.color) process.env['NO_COLOR'] = '1';
  const lines: string[] = [];
  const p = report.config.params;

  const statusLabel =
    report.status === 'critical'
      ? pc.red('CRITICAL (below 0.50)')
      : report.status === 'at-risk'
        ? pc.yellow('AT RISK (below 0.60)')
        : pc.green('OK (above 0.60)');

  lines.push(
    `${pc.bold('skill-diag')} v${opts.version} · routing survival model · r=${p.r} p=${p.p} (${p.source})`,
  );
  lines.push(
    `Routing health    estimated top-1 ${pc.bold(fmt(report.adjustedTop1))}  (N=${report.n.toLocaleString('en-US')}, N_eff=${report.nEff.toLocaleString('en-US')})`,
  );
  lines.push(`  naive          ${fmt(report.naiveTop1)}`);
  if (report.clusters.count === 0) {
    lines.push(
      `  duplicate-adj  ${fmt(report.adjustedTop1)}  ${pc.dim(`(no clusters detected at threshold ${report.config.similarityThreshold})`)}`,
    );
  } else {
    const delta = report.naiveTop1 - report.adjustedTop1;
    lines.push(
      `  duplicate-adj  ${fmt(report.adjustedTop1)}  ${pc.yellow(`(${report.clusters.count} cluster(s), ${report.clusters.clusteredSkills} skills, −${fmt(delta)})`)}`,
    );
  }
  lines.push(
    `  break point (0.50) at N ≈ ${report.breakPoints.critical.nStar.toLocaleString('en-US')}   headroom: ${report.breakPoints.critical.headroom.toLocaleString('en-US')} skills`,
  );
  lines.push(
    `  warning threshold (0.60) at N ≈ ${report.breakPoints.warning.nStar.toLocaleString('en-US')}   headroom: ${report.breakPoints.warning.headroom.toLocaleString('en-US')} skills`,
  );
  lines.push(`  current status  ${statusLabel}`);

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
      lines.push(pc.dim(`  … ${report.clusters.members.length - shown.length} more member(s); use --json for the full list`));
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
  lines.push(
    pc.dim(
      `parameters: ${p.source} (${p.citation}) · collisionWeight=${report.config.collisionWeight} · threshold=${report.config.similarityThreshold} · shingle=${report.config.shingleSize}`,
    ),
  );
  return `${lines.join('\n')}\n`;
}

export function toRoutingJson(
  report: RoutingReport,
  opts: { version: string; generatedAt?: string },
): unknown {
  const p = report.config.params;
  return {
    version: '1',
    tool: { name: 'skill-diag', version: opts.version },
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
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
      breakPoints: {
        warning: {
          theta: report.breakPoints.warning.theta,
          nStar: report.breakPoints.warning.nStar,
          headroom: report.breakPoints.warning.headroom,
        },
        critical: {
          theta: report.breakPoints.critical.theta,
          nStar: report.breakPoints.critical.nStar,
          headroom: report.breakPoints.critical.headroom,
        },
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
