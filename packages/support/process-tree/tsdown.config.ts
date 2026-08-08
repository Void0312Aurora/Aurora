import { defineConfig } from 'tsdown'

/**
 * Bundles the tsc output of `src/index.ts` to the package's `lib/index.js`,
 * keeping the root config's fixed `.js` ESM extension (per-package configs do
 * not inherit `fixedExtension: false`). TypeScript owns declarations under
 * `lib/types/`; this build produces runtime bundles only.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
