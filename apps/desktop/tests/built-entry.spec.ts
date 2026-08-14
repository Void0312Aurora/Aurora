/**
 * Built-entry smoke: verify that the compiled `lib/types/` module graph is
 * self-consistent — every relative import resolves to an existing file.
 * This is the minimal guard against the import-depth class of bugs
 * introduced by outDir changes (e.g. lib/types adding an extra directory
 * level that breaks relative specifiers — the post-tsc fixup script must
 * rewrite the import to the depth-2 form). The test does not import Electron,
 * so it runs keyless in any Node environment.
 *
 * IMPORTANT: the compiled entry lives at `lib/types/` (depth 2); the
 * materialized workspace primitives live at `lib/process-tree/` and
 * `lib/web-launcher/` (depth 1); web-launcher is its self-contained bundle,
 * while process-tree is its tsc runtime. The post-tsc `fixup-import-paths.mjs`
 * adjusts the package-name source specifiers to the emitted relative forms
 * (`../process-tree/index.js`, `../web-launcher/index.js`). This test
 * verifies the fixed output.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Extracts the target of every relative `import … from '…'` / `export … from '…'`. */
function relativeImportSpecifiers(source: string): string[] {
  const pattern = /(?:import|export)\s.*?\sfrom\s+['"](\.[^'"]+)['"]/gs
  const specs: string[] = []
  for (const m of source.matchAll(pattern)) {
    specs.push(m[1]!)
  }
  return specs
}

const OUT_DIR = resolve(import.meta.dirname, '..', 'lib', 'types')

/**
 * Verify every relative import specifier in a compiled JS file resolves
 * to a real file on disk. Returns the list of resolved paths for further
 * assertion by callers.
 */
async function verifyRelativeImports(entryJs: string): Promise<[string, string][]> {
  const source = await readFile(entryJs, 'utf8')
  const baseDir = dirname(entryJs)
  const specifiers = relativeImportSpecifiers(source)
  const resolved: [string, string][] = []

  for (const spec of specifiers) {
    const target = resolve(baseDir, spec)
    const resolvedPath = existsSync(target)
      ? target
      : existsSync(target + '.js')
        ? target + '.js'
        : null

    expect(resolvedPath, `import "${spec}" in ${entryJs} — resolved path does not exist`).not.toBeNull()
    if (resolvedPath) resolved.push([spec, resolvedPath])
  }
  return resolved
}

describe('built-entry import graph', () => {
  it('main.js: every relative import resolves, and it imports the materialized primitives', async () => {
    const resolved = await verifyRelativeImports(resolve(OUT_DIR, 'main.js'))
    expect(resolved.length, 'main.js must have at least one relative import').toBeGreaterThan(0)
    // The key regression guard: the post-tsc fixup rewrites the specifiers
    // to the depth-2 forms (../process-tree/index.js, ../web-launcher/index.js),
    // which must resolve to lib/<name>/index.js from lib/types/main.js so the
    // packaged app has no runtime node_modules edge.
    const procTreeImport = resolved.find(([, p]) => p.includes('process-tree'))
    expect(procTreeImport, 'main.js must import the process-tree primitive via a relative specifier')
      .toBeDefined()
    expect(procTreeImport![0], 'specifier must be the post-fixup depth-2 form')
      .toBe('../process-tree/index.js')
    const launcherImport = resolved.find(([, p]) => p.includes('web-launcher'))
    expect(launcherImport, 'main.js must import the web-launcher primitive via a relative specifier')
      .toBeDefined()
    expect(launcherImport![0], 'specifier must be the post-fixup depth-2 form')
      .toBe('../web-launcher/index.js')
  })

  it('reaper.js: every relative import resolves, and it imports the process-tree primitive', async () => {
    const resolved = await verifyRelativeImports(resolve(OUT_DIR, 'reaper.js'))
    expect(resolved.length, 'reaper.js must have at least one relative import').toBeGreaterThan(0)
    const procTreeImport = resolved.find(([, p]) => p.includes('process-tree'))
    expect(procTreeImport, 'reaper.js must import the process-tree primitive via a relative specifier')
      .toBeDefined()
    expect(procTreeImport![0], 'specifier must be the post-fixup depth-2 form')
      .toBe('../process-tree/index.js')
  })

  it('process-tree/index.js: any relative imports resolve', async () => {
    await verifyRelativeImports(
      resolve(import.meta.dirname, '..', 'lib', 'process-tree', 'index.js'),
    )
  })

  it('web-launcher/index.js: any relative imports resolve', async () => {
    const entry = resolve(import.meta.dirname, '..', 'lib', 'web-launcher', 'index.js')
    await verifyRelativeImports(entry)
    const source = await readFile(entry, 'utf8')
    expect(source, 'materialized web-launcher must inline its Windows spawn compatibility dependency')
      .not.toMatch(/from ["']cross-spawn["']/)
  })
})
