/** Launch the desktop shell without inheriting Electron's Node-compat mode. */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const electronPath = require_('electron')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const result = spawnSync(electronPath, ['.'], {
  cwd: new URL('..', import.meta.url),
  env,
  stdio: 'inherit',
})

if (result.error !== undefined) throw result.error
if (result.signal !== null) {
  process.kill(process.pid, result.signal)
} else {
  process.exitCode = result.status ?? 1
}
