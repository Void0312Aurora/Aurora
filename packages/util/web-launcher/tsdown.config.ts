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
  deps: {
    // Shell hosts materialize or inline this bundle and carry no runtime
    // node_modules edge; keep the Windows shim implementation self-contained.
    alwaysBundle: ['cross-spawn'],
    onlyBundle: ['cross-spawn', 'isexe', 'path-key', 'shebang-command', 'shebang-regex', 'which'],
  },
})
