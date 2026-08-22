/**
 * Host-platform vsix packer. The materialized closure carries native addons
 * selected by pnpm for the running platform and architecture, so the vsce
 * target must match that host. `DSH_VSIX_TARGET` is an optional CI assertion,
 * not a cross-compilation switch: a mismatch fails before vsce runs.
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

/** Map the running platform+arch to vsce's target triple; the default when DSH_VSIX_TARGET is unset. */
function hostTarget() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  switch (process.platform) {
    case 'win32': return `win32-${arch}`
    case 'darwin': return `darwin-${arch}`
    case 'linux': return `linux-${arch}`
    default: return `${process.platform}-${arch}`
  }
}

const target = process.env.DSH_VSIX_TARGET && process.env.DSH_VSIX_TARGET !== ''
  ? process.env.DSH_VSIX_TARGET
  : hostTarget()
const detectedTarget = hostTarget()
if (target !== detectedTarget) {
  console.error(
    `[dsh-vscode] target ${target} does not match this materialized closure (${detectedTarget}); package on a matching runner`,
  )
  process.exit(1)
}

// Resolve vsce from this package's own dependency tree so the packer never
// depends on a globally installed binary.
const require = createRequire(import.meta.url)
const vsceBin = require.resolve('@vscode/vsce/vsce')

console.log(`[dsh-vscode] packaging vsix for target ${target}`)
const result = spawnSync(process.execPath, [vsceBin, 'package', '--no-dependencies', '--target', target], {
  stdio: 'inherit',
})
if (result.status !== 0) {
  process.exit(result.status ?? 1)
}
