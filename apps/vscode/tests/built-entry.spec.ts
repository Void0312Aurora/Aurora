/**
 * Built extension-host closure: the vsix excludes node_modules, so every
 * workspace runtime and third-party helper must be inside extension.js. Node
 * built-ins and the host-injected `vscode` API are the only external imports.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('built extension-host entry', () => {
  it('has no runtime package imports beyond the host API', async () => {
    const entry = resolve(import.meta.dirname, '..', 'dist', 'extension.js')
    const source = await readFile(entry, 'utf8')
    const imports = source.split(/\r?\n/).flatMap((line) => {
      const match = /^import\b.*\bfrom\s+["']([^"']+)["'];?$/.exec(line)
      return match?.[1] === undefined ? [] : [match[1]]
    })
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.filter(specifier => specifier !== 'vscode' && !specifier.startsWith('node:'))).toEqual([])
  })
})
