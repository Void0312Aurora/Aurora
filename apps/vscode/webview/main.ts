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
import { parseBridgeResponseMessage } from '@deepseek-ai/dsh-client-connection/client'
import { staticBootGraph, staticPlugins } from './roster.ts'

/** The VS Code webview messaging face (acquireVsCodeApi is call-once). */
interface VsCodeWebviewApi {
  postMessage(message: BridgeRequestMessage): void
}

declare function acquireVsCodeApi(): VsCodeWebviewApi

// `?fixture` is the keyless runnable-example mode used by the browser snapshot:
// without a bridge seat, the shared connection plugin selects FixtureApiClient.
// Production panel documents carry no query and always take the host bridge.
if (!new URLSearchParams(location.search).has('fixture')) {
  const vscodeApi = acquireVsCodeApi()
  const listeners = new Set<(message: unknown) => void>()
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const parsed = parseBridgeResponseMessage(event.data)
    if (parsed.ok) {
      for (const listener of [...listeners]) listener(parsed.message)
    } else if (parsed.id !== undefined) {
      // Preserve correlation for a malformed frame so the owning fetch fails
      // and cleans up instead of waiting forever on an untrusted message.
      const error: BridgeResponseMessage = {
        type: 'dsh-fetch-error',
        id: parsed.id,
        message: `invalid bridge response: ${parsed.reason}`,
      }
      for (const listener of [...listeners]) listener(error)
    }
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
}
;(globalThis as unknown as DshWindow).__DSH_BOOT__ = staticBootGraph()

const root = document.getElementById('root')
if (root === null) throw new Error('dsh webview: #root missing from the panel HTML')
void new AppWebEntry(root, { staticPlugins }).run()
