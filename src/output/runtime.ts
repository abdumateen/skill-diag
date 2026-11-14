/**
 * Phase 4a: human and JSON rendering for `runtime report`.
 */

import pc from 'picocolors';
import { MIN_SESSIONS } from '../model/runtime.js';
import type { RuntimeJoin } from '../model/runtime.js';
import { stringify } from './json.js';

export interface RuntimeRenderOptions {
  readonly version: string;
  readonly storePath: string;
  readonly color?: boolean;
}

export function renderRuntimeHuman(data: RuntimeJoin, opts: RuntimeRenderOptions): string {
  if (opts.color === false) process.env['NO_COLOR'] = '1';
  const lines = [
    `${pc.bold('skill-diag')} v${opts.version} · runtime activation join`,
    `store: ${opts.storePath}`,
    `sessions observed: ${data.sessions}`,
    `skills with activations: ${data.observedSkills.length}`,
  ];
  if (data.sessions < MIN_SESSIONS) {
    lines.push(
      pc.dim(`below ${MIN_SESSIONS} sessions — zero-activation flags need more evidence`),
    );
  } else {
    lines.push(`zero-activation skills: ${data.zeroActivation.length}`);
    for (const name of data.zeroActivation) lines.push(`  zero-activation  ${name}`);
    lines.push(`trigger-theft suspects: ${data.theftSuspects.length}`);
    for (const row of data.skills.filter((skill) => skill.theftSuspect)) {
      const thief = row.thiefNeighbor;
      lines.push(
        `  trigger-theft-suspect  ${row.name} — 0 activations; ${thief?.name} fired ${thief?.activations} times`,
      );
    }
  }
  lines.push('top firing skills:');
  if (data.topFiring.length === 0) {
    lines.push(pc.dim('  (none)'));
  } else {
    for (const entry of data.topFiring) {
      lines.push(`  ${String(entry.activations).padStart(4)}  ${entry.name}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function toRuntimeJson(
  data: RuntimeJoin,
  opts: RuntimeRenderOptions,
): string {
  return stringify({
    version: '1',
    tool: { name: 'skill-diag', version: opts.version },
    runtime: {
      storePath: opts.storePath,
      sessions: data.sessions,
      observedSkills: data.observedSkills,
      zeroActivation: data.zeroActivation,
      theftSuspects: data.theftSuspects,
      topFiring: data.topFiring,
      skills: data.skills,
    },
  });
}
