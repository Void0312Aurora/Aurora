/**
 * Materialize the `@deepseek-ai/dsh-process-tree` primitive into this
 * package's build output so the emitted `lib/` is self-contained. The desktop
 * shell must not carry runtime node_modules edges (electron-builder's `files`
 * whitelist packs only `lib/`, `build/`, `deploy/`, and `package.json`), so
 * the primitive is compiled here and copied as plain files into
 * `lib/process-tree/`; `main.ts` and `reaper.ts` import it by that relative
 * path, and the asar unpacks `lib/process-tree/**` so the Electron-as-Node
 * reaper can read it.
 *
 * Runs before every `tsc` invocation of this package (the desktop `build`
 * script and the repository `build:lib` chain both call it), so a clean
 * checkout — where neither `lib/` nor the gitignored `deploy/` exists yet —
 * resolves the import.
 */

import { execSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const primitiveDir = join(repoRoot, 'packages', 'support', 'process-tree')
const destination = join(repoRoot, 'apps', 'desktop', 'lib', 'process-tree')

// The primitive has no build script of its own (support-package convention:
// the repository `tsc -b` graph builds it); compile it explicitly so this
// materialization is self-sufficient outside that graph.
execSync(`pnpm exec tsc -b ${primitiveDir}/tsconfig.json`, { cwd: repoRoot, stdio: 'inherit' })

rmSync(destination, { recursive: true, force: true })
mkdirSync(destination, { recursive: true })
cpSync(join(primitiveDir, 'lib', 'types'), destination, { recursive: true })
console.log(`[dsh-desktop] materialize-process-tree: copied ${primitiveDir}/lib/types -> ${destination}`)
