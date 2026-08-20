/**
 * Materialize this package's workspace runtime imports into its build output
 * so the emitted `lib/` is self-contained. The desktop shell must not carry
 * runtime node_modules edges (electron-builder's `files` whitelist packs only
 * `lib/`, `build/`, `deploy/`, and `package.json`). The process-tree runtime is
 * copied from tsc output, while web-launcher is copied from its self-contained
 * bundle; the post-compile fixup routes the emitted entries to those relative
 * paths, and the asar unpacks `lib/process-tree/**` so the Electron-as-Node
 * reaper can read it (the launcher is only imported by the asar-hosted main).
 *
 * Runs before every `tsc` invocation of this package (the desktop `build`
 * script and the repository `build:lib` chain both call it), so a clean
 * checkout — where neither `lib/` nor the gitignored `deploy/` exists yet —
 * resolves the imports.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const require = createRequire(import.meta.url)
const tsc = require.resolve('typescript/bin/tsc')
const tsdown = require.resolve('tsdown/run')

/** Workspace primitives copied into lib/<name>/index.js for the packaged app. */
const PRIMITIVES = [
  { name: 'process-tree', bundled: false },
  { name: 'web-launcher', bundled: true },
]

for (const { name, bundled } of PRIMITIVES) {
  const primitiveDir = join(repoRoot, 'packages', 'util', name)
  const primitiveConfig = join(primitiveDir, 'tsconfig.json')
  const destination = join(repoRoot, 'apps', 'desktop', 'lib', name)

  // Compile each primitive explicitly so materialization remains independent
  // of the repository build graph. Bundled descriptors then run their package
  // tsdown config before the selected runtime is copied. `--force` prevents a
  // stale incremental record from standing in for the ignored output.
  rmSync(destination, { recursive: true, force: true })
  execFileSync(process.execPath, [tsc, '-b', primitiveConfig, '--force'], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  if (bundled) {
    execFileSync(process.execPath, [tsdown, '--config', join(primitiveDir, 'tsdown.config.ts')], {
      cwd: primitiveDir,
      stdio: 'inherit',
    })
  }
  const primitiveRuntime = join(primitiveDir, 'lib', bundled ? 'index.js' : join('types', 'index.js'))
  mkdirSync(destination, { recursive: true })
  copyFileSync(primitiveRuntime, join(destination, 'index.js'))
  console.log(`[dsh-desktop] materialize-workspace-deps: copied ${primitiveRuntime} -> ${destination}`)
}
