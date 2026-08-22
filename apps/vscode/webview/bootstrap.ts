/** Protocol-gated startup for the independently released VS Code webview. */

import type { WebviewBridgePort } from '@deepseek-ai/dsh-client-connection/client'
import { verifyWebviewBridgeProtocol } from '@deepseek-ai/dsh-client-connection/client'

/** Inputs shared by fixture and external-host webview startup. */
interface WebviewBootOptions {
  /** Root element receiving the incompatibility state when the gate fails. */
  root: HTMLElement
  /** Start the ordinary client plugin graph. */
  run(): Promise<void>
}

/** Inputs for booting the client graph after host compatibility is known. */
export type GatedWebviewBootOptions = WebviewBootOptions & (
  | {
    /** Embedder bridge used for the pre-boot protocol probe and client graph. */
    bridge: WebviewBridgePort
    /** Resolves after the managed server accepts HTTP requests. */
    hostReady: Promise<void>
  }
  | {
    /** Fixture mode has no external host. */
    bridge?: undefined
    hostReady?: never
  }
)

/**
 * Publish the bridge and run the client graph only after `host.describe`
 * confirms protocol compatibility. Fixture mode runs without a bridge.
 * @param options - root, optional bridge, and client runner.
 * @returns true when the client graph started.
 */
export async function bootGatedWebview(options: GatedWebviewBootOptions): Promise<boolean> {
  if (options.bridge !== undefined) {
    await options.hostReady
    const check = await verifyWebviewBridgeProtocol(options.bridge)
    if (!check.ok) {
      renderIncompatibleHost(options.root, check.reason)
      return false
    }
    globalThis.__DSH_WEBVIEW_BRIDGE__ = options.bridge
  }
  await options.run()
  return true
}

/** Render the terminal state for an external host with an incompatible API. */
function renderIncompatibleHost(root: HTMLElement, reason: string): void {
  const region = document.createElement('section')
  region.setAttribute('role', 'alert')
  const heading = document.createElement('h1')
  heading.textContent = 'Incompatible DeepSeek Harness host'
  const detail = document.createElement('p')
  detail.textContent = reason
  const action = document.createElement('p')
  action.textContent = 'Update the VS Code extension and dsh to compatible versions, then run Developer: Reload Window.'
  region.append(heading, detail, action)
  root.replaceChildren(region)
}
