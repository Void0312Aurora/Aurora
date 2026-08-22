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
 * The client plugin packages bundled statically into the webview (the
 * `/client` subpath of each roster row plus the platform packages the shell
 * itself aliases). tsconfig paths cover bare package names; the `/client`
 * subpaths need explicit rows because tsconfig.base.json maps only a few of
 * them. Order matters — subpath aliases must win over bare-name prefixes.
 */
const CLIENT_SUBPATH_PACKAGES = [
  'connection', 'runtime', 'ui-theme', 'locale', 'ui-layout', 'ui-sidebar',
  'ui-settings', 'ui-settings-general', 'ui-models', 'ui-conversation',
  'ui-workspace', 'ui-slash', 'ui-command', 'ui-skill', 'ui-subagent',
  'ui-goal', 'ui-model', 'ui-permission', 'ui-plan', 'ui-question',
  'ui-trajectory',
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
      ...CLIENT_SUBPATH_PACKAGES.map(name => ({
        find: new RegExp(`^@deepseek-ai/dsh-client-${name}/client$`),
        replacement: src(`../../../packages/client/${name}/src/client/index.ts`),
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
