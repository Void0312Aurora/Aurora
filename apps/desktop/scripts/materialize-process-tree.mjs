/**
 * Materialize the `@deepseek-ai/dsh-process-tree` primitive into this
 * package's build output so the emitted `lib/` is self-contained. The desktop
 * shell must not carry runtime node_modules edges (electron-builder's `files`
 * whitelist packs only `lib/`, `build/`, `deploy/`, and `package.json`), so
 * the primitive is compiled here and copied as plain JavaScript into
 * `lib/process-tree/`; the post-compile fixup routes `main.ts` and `reaper.ts`
 * output to that relative path, and the asar unpacks `lib/process-tree/**` so
 * the Electron-as-Node reaper can read it.
 *
 * Runs before every `tsc` invocation of this package (the desktop `build`
 * script and the repository `build:lib` chain both call it), so a clean
 * checkout — where neither `lib/` nor the gitignored `deploy/` exists yet —
 * resolves the import.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const primitiveDir = join(repoRoot, 'packages', 'util', 'process-tree')
const primitiveConfig = join(primitiveDir, 'tsconfig.json')
const primitiveRuntime = join(primitiveDir, 'lib', 'types', 'index.js')
const destination = join(repoRoot, 'apps', 'desktop', 'lib', 'process-tree')
const require = createRequire(import.meta.url)
const tsc = require.resolve('typescript/bin/tsc')

// The primitive has no build script of its own (support-package convention:
// the repository `tsc -b` graph builds it); compile it explicitly so this
// materialization is self-sufficient outside that graph. `--force` prevents
// a stale incremental record from standing in for the ignored output.
rmSync(destination, { recursive: true, force: true })
execFileSync(process.execPath, [tsc, '-b', primitiveConfig, '--force'], {
  cwd: repoRoot,
  stdio: 'inherit',
})
mkdirSync(destination, { recursive: true })
copyFileSync(primitiveRuntime, join(destination, 'index.js'))
console.log(`[dsh-desktop] materialize-process-tree: copied ${primitiveRuntime} -> ${destination}`)
