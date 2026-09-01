import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { vsixTarget } from '../scripts/vsix-target.mjs'

const APP_ROOT = join(import.meta.dirname, '..')
const PACKER = join(APP_ROOT, 'scripts/package-vsix.mjs')

describe('VSIX packaging contract', () => {
  it.each([
    ['win32', 'x64', undefined, 'win32-x64'],
    ['win32', 'arm64', undefined, 'win32-arm64'],
    ['darwin', 'x64', undefined, 'darwin-x64'],
    ['darwin', 'arm64', undefined, 'darwin-arm64'],
    ['linux', 'x64', 'glibc', 'linux-x64'],
    ['linux', 'arm64', 'glibc', 'linux-arm64'],
    ['linux', 'arm', 'glibc', 'linux-armhf'],
    ['linux', 'x64', 'musl', 'alpine-x64'],
    ['linux', 'arm64', 'musl', 'alpine-arm64'],
  ] as const)('maps %s/%s/%s to %s', (platform, arch, libc, target) => {
    expect(vsixTarget(platform, arch, libc)).toBe(target)
  })

  it.each([
    ['win32', 'ia32', undefined],
    ['darwin', 'arm', undefined],
    ['linux', 'arm', 'musl'],
    ['linux', 'ppc64', 'glibc'],
    ['freebsd', 'x64', undefined],
  ] as const)('rejects unsupported host %s/%s/%s', (platform, arch, libc) => {
    expect(() => vsixTarget(platform, arch, libc)).toThrow(/unsupported VSIX host/)
  })

  it('rejects a target that cannot match the host-materialized closure', () => {
    const mismatchedTarget = process.platform === 'win32' ? 'linux-x64' : 'win32-x64'
    const result = spawnSync(process.execPath, [PACKER], {
      encoding: 'utf8',
      env: { ...process.env, DSH_VSIX_TARGET: mismatchedTarget },
    })

    expect(result.status).toBe(1)
    const diagnostics = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    expect(diagnostics).toContain('does not match this materialized closure')
    expect(diagnostics).toContain('package on a matching runner')
  })

  it('publishes the canonical source repository', () => {
    const manifest = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as {
      repository?: { url?: string; directory?: string }
    }
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'https://github.com/deepseek-ai/deepseek-harness.git',
      directory: 'apps/vscode',
    })
  })
})
