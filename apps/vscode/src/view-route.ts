/** Host-side retention and replay for Secondary Side Bar route commands. */

import type {
  RouteMessage,
  WebviewHostReadyMessage,
} from '../webview/route-bridge.ts'

/** Minimal webview face required to post one route command. */
export interface RouteMessageSink {
  postMessage(message: RouteMessage | WebviewHostReadyMessage): Thenable<boolean>
}

/** Retains server readiness and the latest route until the webview reports readiness. */
export class ViewRouteRelay<T extends RouteMessageSink> {
  private current: T | undefined
  private ready = false
  private hostReady = false
  private pending: RouteMessage['route'] | undefined

  /** Adopt a newly resolved webview; it must send a fresh ready message. */
  attach(webview: T): void {
    this.current = webview
    this.ready = false
  }

  /** Retain a route request and deliver it immediately when the view is ready. */
  routeTo(route: RouteMessage['route']): void {
    this.pending = route
    this.postPending()
  }

  /** Retain managed-server readiness and deliver it to the current ready webview. */
  markHostReady(): void {
    this.hostReady = true
    this.postHostReady()
  }

  /** Clear managed-server readiness before restart, exit, or teardown. */
  markHostUnavailable(): void {
    this.hostReady = false
  }

  /** Mark the current webview ready and replay the latest retained route. */
  markWebviewReady(webview: T): void {
    if (this.current !== webview) return
    this.ready = true
    this.postHostReady()
    this.postPending()
  }

  /** Detach a disposed webview while retaining the desired route for its successor. */
  detach(webview: T): void {
    if (this.current !== webview) return
    this.current = undefined
    this.ready = false
  }

  private postPending(): void {
    if (!this.ready || this.current === undefined || this.pending === undefined) return
    const message: RouteMessage = { type: 'dsh-route', route: this.pending }
    void this.current.postMessage(message)
  }

  private postHostReady(): void {
    if (!this.ready || !this.hostReady || this.current === undefined) return
    void this.current.postMessage({ type: 'dsh-host-ready' })
  }
}
