import { describe, expect, it, vi } from 'vitest'
import { ViewRouteRelay } from '../src/view-route.ts'

function sink() {
  return { postMessage: vi.fn(async () => true) }
}

describe('ViewRouteRelay', () => {
  it('replays only the latest route requested before webview readiness', () => {
    const relay = new ViewRouteRelay()
    const webview = sink()
    relay.routeTo('sessions')
    relay.routeTo('chat')
    relay.attach(webview)
    expect(webview.postMessage).not.toHaveBeenCalled()

    relay.markWebviewReady(webview)
    expect(webview.postMessage).toHaveBeenCalledOnce()
    expect(webview.postMessage).toHaveBeenCalledWith({ type: 'dsh-route', route: 'chat' })
  })

  it('replays retained server readiness only after the current webview is ready', () => {
    const relay = new ViewRouteRelay()
    const view = sink()
    relay.markHostReady()
    relay.attach(view)
    expect(view.postMessage).not.toHaveBeenCalled()

    relay.markWebviewReady(view)
    expect(view.postMessage).toHaveBeenCalledWith({ type: 'dsh-host-ready' })

    relay.markHostUnavailable()
    const replacement = sink()
    relay.attach(replacement)
    relay.markWebviewReady(replacement)
    expect(replacement.postMessage).not.toHaveBeenCalled()
  })

  it('ignores stale readiness and replays the retained route to a replacement view', () => {
    const relay = new ViewRouteRelay()
    const first = sink()
    const second = sink()
    relay.attach(first)
    relay.routeTo('sessions')
    relay.detach(first)
    relay.attach(second)

    relay.markWebviewReady(first)
    expect(first.postMessage).not.toHaveBeenCalled()
    relay.markWebviewReady(second)
    expect(second.postMessage).toHaveBeenCalledWith({ type: 'dsh-route', route: 'sessions' })
  })
})
