import { describe, expect, it, vi } from 'vitest'
import type { Browser } from 'playwright'
import { launchBrowserForServer, type CloseableServer } from './support/webview-browser.ts'

describe('launchBrowserForServer', () => {
  it('closes the HTTP server before rethrowing a browser launch failure', async () => {
    const events: string[] = []
    const server: CloseableServer = {
      close(callback) {
        events.push('server closed')
        callback()
      },
    }
    const launch = vi.fn(async (): Promise<Browser> => {
      events.push('launch failed')
      throw new Error('chromium unavailable')
    })

    await expect(launchBrowserForServer(server, 'http://127.0.0.1:1', launch))
      .rejects.toThrow(/chromium unavailable/)
    expect(events).toEqual(['launch failed', 'server closed'])
  })
})
