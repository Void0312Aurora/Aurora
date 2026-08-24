import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const verifier = join(root, 'scripts', 'verify-runtime-closure.ts')
const tsx = createRequire(import.meta.url).resolve('tsx/cli')
const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

function runParity(desktop: Record<string, string>, vscode: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-runtime-parity-'))
  temporary.push(directory)
  const desktopPath = join(directory, 'desktop.json')
  const vscodePath = join(directory, 'vscode.json')
  writeFileSync(desktopPath, JSON.stringify({ dependencies: desktop }))
  writeFileSync(vscodePath, JSON.stringify({ dependencies: vscode }))
  return spawnSync(process.execPath, [tsx, verifier, '--desktop-manifest', desktopPath, '--vscode-manifest', vscodePath], {
    cwd: root,
    encoding: 'utf8',
  })
}

describe('runtime closure product parity', () => {
  it('fails loud when the two products pin different versions', () => {
    const result = runParity({ cordis: '4.0.0' }, { cordis: '4.1.0' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('cordis: desktop=4.0.0; vscode=4.1.0')
  })

  it('fails loud when one product omits a dependency', () => {
    const result = runParity({ cordis: '4.0.0', cosmokit: '1.0.0' }, { cordis: '4.0.0' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('cosmokit: desktop=1.0.0; vscode=<missing>')
  })
})
