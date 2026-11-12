import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // No banner: src/cli.ts already carries the shebang and esbuild hoists it to
  // line 1. A second one here lands on line 2 and breaks the ESM parse.
});
