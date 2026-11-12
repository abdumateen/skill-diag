import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Bundle runtime dependencies. Leaving them external made every invocation
  // resolve and load node_modules, which on Windows costs several hundred ms
  // in file-system scans and dominated the 100-skill runtime gate.
  // Bundle the runtime deps: leaving them external made every invocation
  // resolve node_modules, which on Windows dominates startup.
  noExternal: ['yaml', 'picocolors'],
  // `yaml` is CommonJS-only, so its bundled code calls require() for node
  // builtins. esbuild's `__require` helper uses a real `require` when one is in
  // scope, so provide one. commander stays external: it is loaded lazily enough
  // that bundling it is not worth the same workaround.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  // No banner: src/cli.ts already carries the shebang and esbuild hoists it to
  // line 1. A second one here lands on line 2 and breaks the ESM parse.
});
