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
} from '@deepseek-ai/dsh-client-connection/client'
import { staticBootGraph, staticPlugins } from './roster.ts'

/** Signals exchanged around client boot so the bridge never races the host. */
interface WebviewReadyMessage {
  type: 'dsh-webview-ready'
}

interface WebviewHostReadyMessage {
  type: 'dsh-host-ready'
}

type PanelMessage = BridgeResponseMessage | WebviewHostReadyMessage

/** The VS Code webview messaging face (acquireVsCodeApi is call-once). */
interface VsCodeWebviewApi {
  postMessage(message: BridgeRequestMessage | WebviewReadyMessage): void
}

declare function acquireVsCodeApi(): VsCodeWebviewApi

const vscodeApi = acquireVsCodeApi()
const listeners = new Set<(message: BridgeResponseMessage) => void>()
let resolveHostReady: (() => void) | undefined
const hostReady = new Promise<void>((resolve) => { resolveHostReady = resolve })
window.addEventListener('message', (event: MessageEvent<PanelMessage>) => {
  if (event.data?.type === 'dsh-host-ready') {
    resolveHostReady?.()
    resolveHostReady = undefined
    return
  }
  for (const listener of [...listeners]) listener(event.data)
})

// The bridge port must be seated before the client tree boots: the
// connection plugin's apply reads it to select the postMessage transport.
globalThis.__DSH_WEBVIEW_BRIDGE__ = {
  postMessage: (message) => { vscodeApi.postMessage(message) },
  onMessage: (listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}
;(globalThis as unknown as DshWindow).__DSH_BOOT__ = staticBootGraph()

// The extension host responds with dsh-host-ready only after its managed
// server is accepting HTTP. Keeping this handshake before AppWebEntry boots
// removes the initial connection-lost/retry race from panel startup.
vscodeApi.postMessage({ type: 'dsh-webview-ready' })

const root = document.getElementById('root')
if (root === null) throw new Error('dsh webview: #root missing from the panel HTML')
void hostReady.then(() => new AppWebEntry(root, { staticPlugins }).run())
