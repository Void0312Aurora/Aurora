import { defineConfig } from 'tsdown'

/**
 * Extension-host bundle: one self-contained ESM entry (workspace runtime
 * imports are inlined from their built lib/, so the packaged extension needs
 * no node_modules). Only the VS Code API stays external — the host injects
 * it — and node built-ins resolve at runtime.
 */
export default defineConfig({
  entry: ['src/extension.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  external: ['vscode'],
})
