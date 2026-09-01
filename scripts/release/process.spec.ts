/** Release subprocess behavior at the host command boundary. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { attempt } from './process.ts'

describe('release process helper', () => {
  it('captures a directly executable command', () => {
    const result = attempt(process.execPath, ['-e', 'process.stdout.write("release-ok")'])

    expect(result).toEqual({ status: 0, stdout: 'release-ok', stderr: '' })
  })

  it.runIf(process.platform === 'win32')('runs PATH-resolved and absolute cmd shims on Windows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-release-process-'))
    try {
      const shim = join(directory, 'release-fixture.cmd')
      writeFileSync(shim, '@echo off\r\necho args:%*\r\n', 'utf8')
      const env = { ...process.env }
      const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
      env[pathKey] = `${directory}${delimiter}${env[pathKey] ?? ''}`
      env.PATHEXT ??= '.COM;.EXE;.BAT;.CMD'

      for (const command of ['release-fixture', shim]) {
        const result = attempt(command, ['alpha', 'two words'], { env })
        expect(result.status).toBe(0)
        expect(result.stderr).toBe('')
        expect(result.stdout.trim()).toBe('args:"alpha" "two words"')
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
