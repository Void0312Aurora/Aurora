/**
 * Post-tsc import-specifier fixup. Desktop source imports the process-tree
 * and web-launcher packages through their public package names, while the
 * packaged Electron app carries self-contained runtime copies under
 * `lib/process-tree/` and `lib/web-launcher/`.
 *
 * This script runs after tsc and rewrites those package edges to the relative
 * runtime copies. Re-running against an already-fixed artifact is a no-op;
 * any other emitted shape fails the build instead of shipping a broken edge.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const PROCESS_TREE = { source: '@deepseek-ai/dsh-process-tree', fixed: '../process-tree/index.js' }
const WEB_LAUNCHER = { source: '@deepseek-ai/dsh-web-launcher', fixed: '../web-launcher/index.js' }

/** Count single- and double-quoted occurrences of one module specifier. */
function countSpecifier(content, specifier) {
  return [`'${specifier}'`, `"${specifier}"`]
    .map((literal) => content.split(literal).length - 1)
    .reduce((total, count) => total + count, 0)
}

/** Apply the depth fixup for one (source, fixed) edge to one compiled JS file's content. */
function fixupEdge(fileRelative, content, edge) {
  const sourceCount = countSpecifier(content, edge.source)
  const fixedCount = countSpecifier(content, edge.fixed)
  if (sourceCount === 0 && fixedCount === 1) {
    console.log(`[dsh-desktop] fixup-import-paths: ${fileRelative} already targets ${edge.fixed}`)
    return content
  }
  if (sourceCount !== 1 || fixedCount !== 0) {
    throw new Error(
      `[dsh-desktop] fixup-import-paths: ${fileRelative} expected exactly one ${edge.source} `
      + `or one ${edge.fixed}; found source=${sourceCount}, fixed=${fixedCount}`,
    )
  }
  console.log(`[dsh-desktop] fixup-import-paths: ${fileRelative} rewritten ${edge.source} → ${edge.fixed}`)
  return content
    .replaceAll(`'${edge.source}'`, `'${edge.fixed}'`)
    .replaceAll(`"${edge.source}"`, `"${edge.fixed}"`)
}

/** Apply every expected edge fixup to one compiled JS file. */
function fixup(fileRelative, edges) {
  const path = join(appRoot, fileRelative)
  let content = readFileSync(path, 'utf8')
  for (const edge of edges) {
    content = fixupEdge(fileRelative, content, edge)
  }
  writeFileSync(path, content, 'utf8')
}

fixup('lib/types/main.js', [PROCESS_TREE, WEB_LAUNCHER])
fixup('lib/types/reaper.js', [PROCESS_TREE])
