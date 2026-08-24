import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

const src = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))

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
    {
      name: 'dsh-vscode-csp-loader-utils',
      enforce: 'pre',
      resolveId(source, importer) {
        const owner = importer?.replaceAll('\\', '/') ?? ''
        if (!owner.includes('/vendor/loader/src/')) return undefined
        if (source !== './config/utils.ts' && source !== './utils.ts') return undefined
        return src('./loader-utils-stub.ts')
      },
    },
    {
      name: 'dsh-vscode-csp-schemastery',
      enforce: 'pre',
      transform(code, id) {
        if (!id.replaceAll('\\', '/').endsWith('/vendor/schemastery/src/index.ts')) return undefined
        const unsafe = "schema.callback = new Function('return ' + schema.callback)()"
        if (!code.includes(unsafe)) throw new Error('schemastery callback evaluator changed; update the webview CSP transform')
        return code.replace(
          unsafe,
          "throw new Error('dsh webview: serialized schema callbacks are disabled by CSP')",
        )
      },
    },
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
      {
        find: /^@deepseek-ai\/dsh-host-directory-picker-browse\/client$/,
        replacement: src('../../../packages/host/directory-picker-browse/src/client/index.ts'),
      },
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
    // React and client stores guard development-only branches with this
    // expression; a webview has no ambient Node `process` object.
    'process.env.NODE_ENV': '"production"',
    // vendored loader index.ts: envData falls to its default branch.
    'process.env.CORDIS_SHARED': 'undefined',
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
