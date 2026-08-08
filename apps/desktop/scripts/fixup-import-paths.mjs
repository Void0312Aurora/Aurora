/**
 * Post-tsc import-specifier fixup. Desktop source imports the process-tree
 * package through its public package name, while the packaged Electron app
 * carries a self-contained runtime copy under `lib/process-tree/`.
 *
 * This script runs after tsc and rewrites that package edge to the relative
 * runtime copy. Re-running against an already-fixed artifact is a no-op;
 * any other emitted shape fails the build instead of shipping a broken edge.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_SPECIFIER = '@deepseek-ai/dsh-process-tree'
const FIXED_SPECIFIER = '../process-tree/index.js'

/** Count single- and double-quoted occurrences of one module specifier. */
function countSpecifier(content, specifier) {
  return [`'${specifier}'`, `"${specifier}"`]
    .map((literal) => content.split(literal).length - 1)
    .reduce((total, count) => total + count, 0)
}

/** Apply the depth fixup to one compiled JS file. */
function fixup(fileRelative) {
  const path = join(appRoot, fileRelative)
  const content = readFileSync(path, 'utf8')
  const sourceCount = countSpecifier(content, SOURCE_SPECIFIER)
  const fixedCount = countSpecifier(content, FIXED_SPECIFIER)
  if (sourceCount === 0 && fixedCount === 1) {
    console.log(`[dsh-desktop] fixup-import-paths: ${fileRelative} already targets ${FIXED_SPECIFIER}`)
    return
  }
  if (sourceCount !== 1 || fixedCount !== 0) {
    throw new Error(
      `[dsh-desktop] fixup-import-paths: ${fileRelative} expected exactly one ${SOURCE_SPECIFIER} `
      + `or one ${FIXED_SPECIFIER}; found source=${sourceCount}, fixed=${fixedCount}`,
    )
  }
  const fixed = content
    .replaceAll(`'${SOURCE_SPECIFIER}'`, `'${FIXED_SPECIFIER}'`)
    .replaceAll(`"${SOURCE_SPECIFIER}"`, `"${FIXED_SPECIFIER}"`)
  writeFileSync(path, fixed, 'utf8')
  console.log(`[dsh-desktop] fixup-import-paths: ${fileRelative} rewritten ${SOURCE_SPECIFIER} → ${FIXED_SPECIFIER}`)
}

fixup('lib/types/main.js')
fixup('lib/types/reaper.js')
