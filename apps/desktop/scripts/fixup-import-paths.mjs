/**
 * Post-tsc import-specifier fixup. The source files at `src/` (depth 1) and
 * the emitted output at `lib/types/` (depth 2) sit at different directory
 * depths, so the relative specifier `../lib/process-tree/index.js` — correct
 * from `src/` — breaks from `lib/types/` (it resolves to `lib/lib/...`).
 *
 * This script runs AFTER tsc and switches the specifier to the depth-2 form
 * (`../process-tree/index.js`) so the compiled entry and reaper can find
 * the materialized tree-kill primitive. It runs before every desktop build
 * (the `build` script chains it after `tsc -p tsconfig.json`).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_SPECIFIER = `'../lib/process-tree/index.js'`
const FIXED_SPECIFIER = `'../process-tree/index.js'`

/** Apply the depth fixup to one compiled JS file. */
function fixup(fileRelative) {
  const path = join(appRoot, fileRelative)
  const content = readFileSync(path, 'utf8')
  if (!content.includes(SOURCE_SPECIFIER)) {
    console.warn(`[dsh-desktop] fixup-import-paths: ${fileRelative} did not contain expected specifier — skipping`)
    return
  }
  writeFileSync(path, content.replaceAll(SOURCE_SPECIFIER, FIXED_SPECIFIER), 'utf8')
  console.log(`[dsh-desktop] fixup-import-paths: ${fileRelative} rewritten ${SOURCE_SPECIFIER} → ${FIXED_SPECIFIER}`)
}

fixup('lib/types/main.js')
fixup('lib/types/reaper.js')
