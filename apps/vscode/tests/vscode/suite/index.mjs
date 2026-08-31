/** Mocha entry called by the VS Code extension-test host. */

import { fileURLToPath } from 'node:url'
import Mocha from 'mocha'

/** Run the built-extension smoke inside the Extension Development Host. */
export async function run() {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 30_000 })
  mocha.addFile(fileURLToPath(new URL('./extension.test.mjs', import.meta.url)))
  await new Promise((resolve, reject) => {
    mocha.run(failures => {
      if (failures === 0) resolve()
      else reject(new Error(`${String(failures)} VS Code extension test(s) failed`))
    })
  })
}
