/**
 * Cross-platform vsix packer. The `--target` must be chosen by the caller (the
 * closure carries platform-native N-API addons, so a vsix is per-platform),
 * but a package.json script cannot portably expand a default: POSIX
 * `${VAR:-default}` is passed through verbatim by Windows `cmd.exe`. This
 * script reads `DSH_VSIX_TARGET` from the environment (defaulting to the host
 * platform's vsce target) and invokes `vsce package` through the workspace's
 * own binary, so packaging works identically on every platform.
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
