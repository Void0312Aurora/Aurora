/** Required Windows artifact smoke for PATH-resolved and absolute npm-style command shims. */

import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawnWebLaunch, WEB_ARGS } from '../packages/util/web-launcher/lib/index.js'

if (process.platform !== 'win32') {
  throw new Error(`windows-command-shim-smoke requires Windows Node, got ${process.platform}`)
}

const directory = await mkdtemp(join(tmpdir(), 'dsh-windows-command-shim-'))
try {
  const shim = join(directory, 'dsh-fixture.cmd')
  await writeFile(shim, '@echo off\r\necho args:%*\r\n', 'utf8')
  const env = { ...process.env }
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = `${directory}${delimiter}${env[pathKey] ?? ''}`
  env.PATHEXT ??= '.COM;.EXE;.BAT;.CMD'

  for (const command of ['dsh-fixture', shim]) {
    const child = spawnWebLaunch({
      command,
      args: [...WEB_ARGS],
      env: {},
      source: 'required Windows command-shim smoke',
    }, { env })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const [code, signal] = await Promise.race([
      once(child, 'close'),
      once(child, 'error').then(([error]) => { throw error }),
    ])
    if (code !== 0 || signal !== null) {
      throw new Error(`${command} exited with code=${String(code)} signal=${String(signal)}; stderr=${stderr}`)
    }
    const expected = 'args:"web" "--host" "127.0.0.1" "--port" "0"'
    if (stdout.trim() !== expected || stderr !== '') {
      throw new Error(`${command} produced stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`)
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}

console.log('windows-command-shim-smoke: PATH-resolved and absolute .cmd launches passed.')
