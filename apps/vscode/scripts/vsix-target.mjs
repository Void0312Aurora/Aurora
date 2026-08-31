/** Pure host-platform mapping for the VSIX packer. */

/**
 * Map a platform, architecture, and Linux libc family to a supported vsce target.
 * @param {NodeJS.Platform} platform
 * @param {string} arch
 * @param {'glibc' | 'musl'} [libc]
 */
export function vsixTarget(platform, arch, libc) {
  if (platform === 'win32' && (arch === 'x64' || arch === 'arm64')) return `win32-${arch}`
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) return `darwin-${arch}`
  if (platform === 'linux') {
    if (libc === 'musl' && (arch === 'x64' || arch === 'arm64')) return `alpine-${arch}`
    if (libc === 'glibc' && (arch === 'x64' || arch === 'arm64')) return `linux-${arch}`
    if (libc === 'glibc' && arch === 'arm') return 'linux-armhf'
  }
  throw new Error(`unsupported VSIX host: platform=${platform}, arch=${arch}${platform === 'linux' ? `, libc=${String(libc)}` : ''}`)
}

/** Detect the current host and return its supported vsce target. */
export function hostVsixTarget() {
  const libc = process.platform === 'linux'
    ? (process.report?.getReport().header.glibcVersionRuntime === undefined ? 'musl' : 'glibc')
    : undefined
  return vsixTarget(process.platform, process.arch, libc)
}
