import { defineConfig } from 'tsdown'

/**
 * Extension-host bundle: one self-contained ESM entry (workspace runtime
 * imports are inlined from their built lib/, so the packaged extension needs
 * no node_modules). The host-provided VS Code API and Node built-ins stay
 * external and resolve at runtime.
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
  // A development extension is loaded outside pnpm's workspace resolver and
  // the eventual vsix carries no node_modules. Inline every package import;
  // only the host-provided vscode module and Node built-ins remain external.
  noExternal: id => id !== 'vscode' && !id.startsWith('node:'),
  external: ['vscode'],
  // The vsix excludes node_modules; both host primitives, including the
  // launcher's Windows command-shim closure, must live in extension.js.
  noExternal: ['@deepseek-ai/dsh-process-tree', '@deepseek-ai/dsh-web-launcher'],
})
