#!/usr/bin/env node
/**
 * build:binary — compile src/cli.ts into a standalone executable with bun.
 *
 * Targets the current OS (bun build --compile defaults to the host platform)
 * and writes dist/skill-diag.exe on Windows, dist/skill-diag elsewhere.
 * Requires bun on PATH; nothing else. Run via `npm run build:binary`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const exeName = platform() === 'win32' ? 'skill-diag.exe' : 'skill-diag';
// npm installs bun as a .cmd shim on Windows; spawning that needs a shell.
const shell = process.platform === 'win32';

const probe = spawnSync('bun', ['--version'], { windowsHide: true, shell });
if (probe.error || probe.status !== 0) {
  console.error(
    'build:binary needs bun on PATH (https://bun.sh). Install it, then rerun `npm run build:binary`.',
  );
  process.exit(1);
}

mkdirSync(path.join(root, 'dist'), { recursive: true });
// All args stay relative to cwd so the shell command never needs quoting.
execFileSync('bun', ['build', 'src/cli.ts', '--compile', '--minify', '--outfile', `dist/${exeName}`], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
  shell,
});
console.log(`built dist/${exeName}`);
