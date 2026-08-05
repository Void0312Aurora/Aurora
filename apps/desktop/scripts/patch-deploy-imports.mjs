/**
 * Post-build fixup for the deploy-relative process-tree import. tsc emits
 * relative import specifiers verbatim, and the desktop's sources sit one
 * level shallower than the emitted `lib/types/` tree: a `../deploy/...`
 * specifier that resolves from `src/` resolves one level too high from
 * `lib/types/` (it would hit `lib/deploy`). This rewrites the emitted
 * specifier to the `../../deploy/...` prefix that reaches the deploy tree
 * from the output location. The source keeps its src-correct spelling; only
 * the emitted `.js` files are adjusted. Run after every `tsc` build (the
 * `build` script chains it; incremental builds that emit nothing leave the
 * already-patched files alone). NOTE: `tsc --watch` does not run this — a
 * watch-rebuilt main/reaper would carry the unpatched specifier, so use the
 * `build` script when the deploy import matters.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const outDir = join(import.meta.dirname, '..', 'lib', 'types')
const FROM = "from '../deploy/node_modules/"
const TO = "from '../../deploy/node_modules/"

let patched = 0
for (const name of readdirSync(outDir)) {
  if (!name.endsWith('.js')) continue
  const path = join(outDir, name)
  const source = readFileSync(path, 'utf8')
  if (!source.includes(FROM)) continue
  writeFileSync(path, source.split(FROM).join(TO))
  patched += 1
  console.log(`[dsh-desktop] patch-deploy-imports: rewrote ${name}`)
}
if (patched === 0) {
  console.log('[dsh-desktop] patch-deploy-imports: no unpatched deploy imports (already patched, or nothing re-emitted)')
}
