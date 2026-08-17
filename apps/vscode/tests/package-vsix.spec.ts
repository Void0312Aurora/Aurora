import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const APP_ROOT = join(import.meta.dirname, '..')
const PACKER = join(APP_ROOT, 'scripts/package-vsix.mjs')

describe('VSIX packaging contract', () => {
  it('rejects a target that cannot match the host-materialized closure', () => {
    const mismatchedTarget = process.platform === 'win32' ? 'linux-x64' : 'win32-x64'
    const result = spawnSync(process.execPath, [PACKER], {
      encoding: 'utf8',
      env: { ...process.env, DSH_VSIX_TARGET: mismatchedTarget },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('does not match this materialized closure')
    expect(result.stderr).toContain('package on a matching runner')
  })

  it('publishes the canonical source repository', () => {
    const manifest = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as {
      repository?: { url?: string; directory?: string }
    }
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'https://github.com/Void0312Aurora/Aurora.git',
      directory: 'apps/vscode',
    })
  })
})
