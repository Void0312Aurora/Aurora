// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeRequestMessage,
  BridgeResponseMessage,
  WebviewBridgePort,
} from '@deepseek-ai/dsh-client-connection/client'
import { bootGatedWebview } from '../webview/bootstrap.ts'

interface FakeBridge {
  port: WebviewBridgePort
  sent: BridgeRequestMessage[]
}

function bridgeFor(value: unknown): FakeBridge {
  const listeners = new Set<(message: BridgeResponseMessage) => void>()
  const sent: BridgeRequestMessage[] = []
  const emit = (message: BridgeResponseMessage): void => {
    for (const listener of [...listeners]) listener(message)
  }
  return {
    sent,
    port: {
      postMessage(message) {
        sent.push(message)
        if (message.type !== 'dsh-fetch') return
        const rpcId = (JSON.parse(message.body ?? '{}') as { rpcId?: string }).rpcId
        queueMicrotask(() => {
          emit({ type: 'dsh-fetch-head', id: message.id, status: 200 })
          emit({
            type: 'dsh-fetch-chunk',
            id: message.id,
            chunk: JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }),
          })
          emit({ type: 'dsh-fetch-end', id: message.id })
        })
      },
      onMessage(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
  }
}

afterEach(() => {
  globalThis.__DSH_WEBVIEW_BRIDGE__ = undefined
  document.body.replaceChildren()
})

describe('bootGatedWebview', () => {
  it.each([
    ['older', { protocolVersion: 0, version: 'old', cwd: '/w', attachedSessions: 0 }],
    ['newer', { protocolVersion: 2, version: 'new', cwd: '/w', attachedSessions: 0 }],
    ['missing', { version: 'unknown', cwd: '/w', attachedSessions: 0 }],
    ['malformed', { protocolVersion: '1', version: 'unknown', cwd: '/w', attachedSessions: 0 }],
  ])('shows an incompatible-host state for an %s protocol without starting the client graph', async (_case, value) => {
    const fake = bridgeFor(value)
    const root = document.createElement('div')
    document.body.append(root)
    const run = vi.fn(async () => {})

    await expect(bootGatedWebview({ root, bridge: fake.port, hostReady: Promise.resolve(), run })).resolves.toBe(false)

    expect(run).not.toHaveBeenCalled()
    expect(globalThis.__DSH_WEBVIEW_BRIDGE__).toBeUndefined()
    const alert = root.querySelector('[role="alert"]')?.textContent
    expect(alert).toMatch(/Incompatible DeepSeek Harness host/)
    expect(alert).toMatch(/Developer: Reload Window/)
    expect(alert).not.toMatch(/restart the server/i)
    const starts = fake.sent.filter(message => message.type === 'dsh-fetch')
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({ path: '/api/host.describe' })
  })

  it('publishes the bridge and starts the client graph after a compatible handshake', async () => {
    const fake = bridgeFor({ protocolVersion: 1, version: 'compatible', cwd: '/w', attachedSessions: 0 })
    const root = document.createElement('div')
    const run = vi.fn(async () => {})

    await expect(bootGatedWebview({ root, bridge: fake.port, hostReady: Promise.resolve(), run })).resolves.toBe(true)
    expect(globalThis.__DSH_WEBVIEW_BRIDGE__).toBe(fake.port)
    expect(run).toHaveBeenCalledOnce()
  })

  it('starts fixture mode without probing or publishing a bridge', async () => {
    const root = document.createElement('div')
    const run = vi.fn(async () => {})
    await expect(bootGatedWebview({ root, run })).resolves.toBe(true)
    expect(run).toHaveBeenCalledOnce()
    expect(globalThis.__DSH_WEBVIEW_BRIDGE__).toBeUndefined()
  })

  it('does not probe or start the client graph before the managed server is ready', async () => {
    const fake = bridgeFor({ protocolVersion: 1, version: 'compatible', cwd: '/w', attachedSessions: 0 })
    const root = document.createElement('div')
    const run = vi.fn(async () => {})
    let release: (() => void) | undefined
    const hostReady = new Promise<void>((resolve) => { release = resolve })

    const boot = bootGatedWebview({ root, bridge: fake.port, hostReady, run })
    await Promise.resolve()
    expect(fake.sent).toEqual([])
    expect(run).not.toHaveBeenCalled()

    release?.()
    await expect(boot).resolves.toBe(true)
    expect(fake.sent.filter(message => message.type === 'dsh-fetch')).toHaveLength(1)
    expect(run).toHaveBeenCalledOnce()
  })
})
