// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { DshWindow, WebBootEntry } from '@deepseek-ai/dsh-client-modules/client'
import { AppWebEntry, type BootOptions } from '../src/index.ts'

const MODULES_ID = '@deepseek-ai/dsh-client-modules'

function setManifest(entries: WebBootEntry[]): void {
  ;(globalThis as DshWindow).__DSH_BOOT__ = { rev: 'test', entries }
}

afterEach(() => {
  delete (globalThis as DshWindow).__DSH_BOOT__
  delete (globalThis as DshWindow).__ModuleLoader__
  delete (globalThis as DshWindow).__DSH_MODULES__
})

describe('AppWebEntry static plugin options', () => {
  it('rejects a static plugin without a matching manifest row before runtime setup', async () => {
    setManifest([])
    const options: BootOptions = { staticPlugins: { '@test/missing': { apply: () => {} } } }

    await expect(new AppWebEntry(document.createElement('div'), options).run())
      .rejects.toThrow('static plugin "@test/missing" is not a boot-manifest row')
    expect((globalThis as DshWindow).__ModuleLoader__).toBeUndefined()
  })

  it('rejects a hosting override of the kernel-owned modules entry', async () => {
    setManifest([{ id: MODULES_ID, url: '/plugins/modules.js', rev: 'test' }])

    await expect(new AppWebEntry(document.createElement('div'), {
      staticPlugins: { [MODULES_ID]: { apply: () => {} } },
    }).run()).rejects.toThrow(`static plugin "${MODULES_ID}" is kernel-owned`)
    expect((globalThis as DshWindow).__ModuleLoader__).toBeUndefined()
  })
})
