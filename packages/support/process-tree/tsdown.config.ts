import { defineConfig } from 'tsdown'

/**
 * Bundles the tsc output of `src/index.ts` to the package's `lib/index.js`,
 * keeping the root config's fixed `.js` ESM extension (per-package configs do
 * not inherit `fixedExtension: false`). The adjacent `lib/index.d.ts` is not
 * produced here — tsdown's dts plugin did not emit one in practice — but by
 * the `tsconfig.dts.json` declaration-only project (see that file).
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  clean: false,
})
