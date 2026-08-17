import { describe, expect, it, vi } from 'vitest'
import {
  asRoute,
  createWebviewRouteChannel,
  isWebviewHostReadyMessage,
  isWebviewReadyMessage,
} from '../webview/route-bridge.ts'

describe('webview route channel', () => {
  it('retains and replays only the latest route received before subscription', () => {
    const channel = createWebviewRouteChannel()
    expect(channel.receive({ type: 'dsh-route', route: 'sessions' })).toBe(true)
    expect(channel.receive({ type: 'dsh-route', route: 'details' })).toBe(true)
    const listener = vi.fn()
    const unsubscribe = channel.subscribe(listener)
    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith('details')
    unsubscribe()
  })

  it('rejects unrelated or malformed host messages', () => {
    expect(asRoute({ type: 'dsh-route', route: 'unknown' })).toBeUndefined()
    expect(asRoute({ type: 'dsh-fetch-end', id: 1 })).toBeUndefined()
    expect(isWebviewReadyMessage({ type: 'dsh-webview-ready' })).toBe(true)
    expect(isWebviewReadyMessage({ type: 'dsh-route', route: 'chat' })).toBe(false)
    expect(isWebviewHostReadyMessage({ type: 'dsh-host-ready' })).toBe(true)
    expect(isWebviewHostReadyMessage({ type: 'dsh-webview-ready' })).toBe(false)
  })
})
