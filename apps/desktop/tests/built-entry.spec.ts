/**
 * Built-entry smoke: verify that the compiled `lib/` module graph is
 * self-consistent — every relative import resolves to an existing file.
 * This is the minimal guard against the import-depth class of bugs
 * introduced by outDir changes (e.g. lib/types adding an extra directory
 * level that breaks relative specifiers). The test does not import Electron,
 * so it runs keyless in any Node environment.
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
  it('main.js: every relative import resolves, and it imports the process-tree primitive', async () => {
    const resolved = await verifyRelativeImports(resolve(import.meta.dirname, '..', 'lib', 'main.js'))
    expect(resolved.length, 'main.js must have at least one relative import').toBeGreaterThan(0)
    // The key regression guard: main.js must import the materialized tree-kill
    // primitive by a relative path that resolves to lib/process-tree/.
    const procTreeImport = resolved.find(([, p]) => p.includes('process-tree'))
    expect(procTreeImport, 'main.js must import the process-tree primitive via a relative specifier')
      .toBeDefined()
  })

  it('reaper.js: every relative import resolves, and it imports the process-tree primitive', async () => {
    const resolved = await verifyRelativeImports(resolve(import.meta.dirname, '..', 'lib', 'reaper.js'))
    expect(resolved.length, 'reaper.js must have at least one relative import').toBeGreaterThan(0)
    const procTreeImport = resolved.find(([, p]) => p.includes('process-tree'))
    expect(procTreeImport, 'reaper.js must import the process-tree primitive via a relative specifier')
      .toBeDefined()
  })

  it('launcher.js: any relative imports resolve', async () => {
    // launcher.js may import only from node:* — that's fine, the check
    // is that if it HAS relative imports, they resolve.
    await verifyRelativeImports(resolve(import.meta.dirname, '..', 'lib', 'launcher.js'))
  })

  it('process-tree/index.js: any relative imports resolve', async () => {
    // The primitive is zero-dependency; it may import only from node:*.
    await verifyRelativeImports(
      resolve(import.meta.dirname, '..', 'lib', 'process-tree', 'index.js'),
    )
  })
})
