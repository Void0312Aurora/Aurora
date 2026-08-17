/**
 * Webview bootstrap: adapt the one-shot VS Code messaging API into the
 * connection package's bridge port, inject the static boot graph, and run
 * the standard web shell kernel over the statically bundled plugin roster.
 * Everything after this file is the ordinary dsh client boot — the webview
 * is just another hosting shell.
 */

import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import type { DshWindow } from '@deepseek-ai/dsh-client-modules/client'
import type {
  BridgeRequestMessage,
  BridgeResponseMessage,
  WebviewBridgePort,
} from '@deepseek-ai/dsh-client-connection/client'
import { bootGatedWebview } from './bootstrap.ts'
import {
  createWebviewRouteChannel,
  isWebviewHostReadyMessage,
  type WebviewReadyMessage,
} from './route-bridge.ts'
import { staticBootGraph, staticPlugins } from './roster.ts'

/** The VS Code webview messaging face (acquireVsCodeApi is call-once). */
interface VsCodeWebviewApi {
  postMessage(message: BridgeRequestMessage | WebviewReadyMessage): void
}

declare function acquireVsCodeApi(): VsCodeWebviewApi

const routeChannel = createWebviewRouteChannel()
globalThis.__DSH_WEBVIEW_ROUTES__ = routeChannel
let bridge: WebviewBridgePort | undefined
let resolveHostReady: (() => void) | undefined
const hostReady = new Promise<void>((resolve) => { resolveHostReady = resolve })

// The listener exists before the webview-ready signal and before client boot.
// Route messages are retained by the channel, host readiness releases the
// protocol gate, and response messages fan out once the probe subscribes.
const bridgeListeners = new Set<(message: BridgeResponseMessage) => void>()
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (routeChannel.receive(event.data)) return
  if (isWebviewHostReadyMessage(event.data)) {
    resolveHostReady?.()
    resolveHostReady = undefined
    return
  }
  for (const listener of [...bridgeListeners]) listener(event.data as BridgeResponseMessage)
})

// `?fixture` is the keyless runnable-example mode used by the browser snapshot.
// Production documents acquire the one-shot VS Code API, announce route
// readiness, then expose the bridge only after the protocol handshake passes.
if (!new URLSearchParams(location.search).has('fixture')) {
  const vscodeApi = acquireVsCodeApi()
  bridge = {
    postMessage: (message) => { vscodeApi.postMessage(message) },
    onMessage: (listener) => {
      bridgeListeners.add(listener)
      return () => { bridgeListeners.delete(listener) }
    },
  }
  vscodeApi.postMessage({ type: 'dsh-webview-ready' })
}
;(globalThis as unknown as DshWindow).__DSH_BOOT__ = staticBootGraph()

const root = document.getElementById('root')
if (root === null) throw new Error('dsh webview: #root missing from the panel HTML')
void bootGatedWebview({
  root,
  ...bridge === undefined ? {} : { bridge, hostReady },
  run: async () => { await new AppWebEntry(root, { staticPlugins }).run() },
})
