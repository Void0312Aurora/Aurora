import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

const src = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))

/**
 * Swap the vendored loader's config utils for the CSP-safe stub. The module is
 * reached through relative imports inside `vendor/loader`, so a specifier
 * alias cannot match it; this resolves first and rewrites by resolved path.
 * @returns the resolver plugin.
 */
function stubLoaderConfigUtils(): Plugin {
  const target = 'vendor/loader/src/config/utils.ts'
  const replacement = src('./loader-config-utils-stub.ts')
  return {
    name: 'dsh-stub-loader-config-utils',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (importer === undefined) return null
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (resolved === null) return null
      return resolved.id.replaceAll('\\', '/').endsWith(target) ? replacement : null
    },
  }
}

/**
 * Source aliases for every `/client` subpath imported by the static roster or
 * its sidebar shell. The official composition includes Client faces outside
 * `packages/client`, so each row names both the package and its source path.
 */
const CLIENT_SUBPATH_ALIASES = [
  ['@deepseek-ai/dsh-typert-registry/client', 'packages/typert/registry/src/client/index.ts'],
  ['@deepseek-ai/dsh-api-gateway/client', 'packages/api/gateway/src/client/index.ts'],
  ['@deepseek-ai/dsh-session-log-export/client', 'packages/session-query/session-log-export/src/client/index.ts'],
  ['@deepseek-ai/dsh-api-remotes/client', 'packages/api/remotes/src/client/index.ts'],
  ['@deepseek-ai/dsh-cordis-client-runner/client', 'packages/extensions/cordis-client-runner/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-cordis/client', 'packages/extensions/ui-cordis/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-connection/client', 'packages/client/connection/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-runtime/client', 'packages/client/runtime/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-theme/client', 'packages/client/ui-theme/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-locale/client', 'packages/client/locale/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-layout/client', 'packages/client/ui-layout/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-sidebar/client', 'packages/client/ui-sidebar/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-settings/client', 'packages/client/ui-settings/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-settings-general/client', 'packages/client/ui-settings-general/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-settings-models/client', 'packages/client/ui-settings-models/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-settings-plugin-inventory/client', 'packages/client/ui-settings-plugin-inventory/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-conversation/client', 'packages/client/ui-conversation/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-tool/client', 'packages/client/ui-tool/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-workflow-run/client', 'packages/client/ui-workflow-run/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-deliverables/client', 'packages/client/ui-deliverables/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-workspace/client', 'packages/client/ui-workspace/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-input-trigger/client', 'packages/client/ui-input-trigger/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-commands/client', 'packages/client/ui-commands/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-skill/client', 'packages/client/ui-skill/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-subagent/client', 'packages/client/ui-subagent/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-jobs/client', 'packages/client/ui-jobs/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-goal/client', 'packages/client/ui-goal/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-message-feedback/client', 'packages/client/ui-message-feedback/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-model-selection/client', 'packages/client/ui-model-selection/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-permission-presets/client', 'packages/client/ui-permission-presets/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-agent-preset/client', 'packages/client/ui-agent-preset/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-settings-plugins/client', 'packages/client/ui-settings-plugins/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-plan/client', 'packages/client/ui-plan/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-user-questions/client', 'packages/client/ui-user-questions/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-trajectory/client', 'packages/client/ui-trajectory/src/client/index.ts'],
] as const

export default defineConfig({
  plugins: [
    stubLoaderConfigUtils(),
    react(),
    // Resolves every bare workspace package name to its src (the same map
    // vitest uses), so the bundle never loads a second lib/ module copy.
    tsconfigPaths({ projects: [src('../../../tsconfig.base.json')] }),
  ],
  resolve: {
    alias: [
      // Browserization of the vendored cordis Loader (same stub contract as
      // apps/web): its only node-only import; the process probes are mapped
      // by `define` below.
      { find: /^node:module$/, replacement: src('./node-module-stub.ts') },
      { find: /^@deepseek-ai\/dsh-client-web$/, replacement: src('../../../packages/client/web/src/boot.tsx') },
      { find: /^@deepseek-ai\/dsh-client-modules\/client$/, replacement: src('../../../packages/client/modules/src/client/index.ts') },
      ...CLIENT_SUBPATH_ALIASES.map(([specifier, source]) => ({
        find: new RegExp(`^${specifier.replaceAll('/', '\\/')}$`),
        replacement: src(`../../../${source}`),
      })),
    ],
  },
  define: {
    // vendored loader internal.ts: fromInternal() probes the Node major —
    // "0.0.0" takes neither branch, returning undefined (exactly the empty
    // internal slot the shell boot fills with the client module loader).
    'process.versions.node': '"0.0.0"',
    'process.execArgv': '[]',
    // vendored loader index.ts: envData falls to its default branch.
    'process.env.CORDIS_SHARED': 'undefined',
    // React's CJS entry branches on this at module top level. An application
    // build (apps/web) gets the substitution from Vite automatically; a LIBRARY
    // build does not, because a library is assumed to be bundled again by its
    // consumer. Nothing bundles this further — the webview loads it directly —
    // so leaving it unset throws `process is not defined` before React mounts
    // and the panel renders blank.
    'process.env.NODE_ENV': '"production"',
  },
  build: {
    outDir: src('../dist/webview'),
    emptyOutDir: true,
    lib: {
      entry: src('./main.ts'),
      formats: ['es'],
      fileName: () => 'webview.js',
      cssFileName: 'webview',
    },
    // One bundle, one stylesheet: the panel HTML serves exactly two assets.
    cssCodeSplit: false,
  },
})
