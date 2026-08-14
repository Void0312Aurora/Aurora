/**
 * Host-driven routing for the sidebar shell. The panel renders no navigation
 * chrome of its own — VS Code's native view title actions own that row, which
 * costs the webview no pixels — so the extension host posts a route message
 * and this plugin turns it into a `ctx.layout` call.
 *
 * It listens on `window` directly rather than through the api client's bridge
 * port: routing is not wire traffic, and keeping it off that channel leaves
 * the connection package's message union untouched.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { NarrowLayoutService } from './shell/service.ts'
import type { NarrowRoute } from './shell/stores.ts'

/** Route command posted by the extension host's title-bar actions. */
export interface RouteMessage {
  type: 'dsh-route'
  route: NarrowRoute
}

/** Narrow an incoming window message to a route command. */
function asRoute(data: unknown): NarrowRoute | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const message = data as Partial<RouteMessage>
  if (message.type !== 'dsh-route') return undefined
  return message.route === 'chat' || message.route === 'sessions' || message.route === 'details'
    ? message.route
    : undefined
}

/** Required services: the shell's layout face carries the routing verbs. */
export const inject = ['layout']

/**
 * Client plugin body: relay host route commands onto the narrow shell.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      const route = asRoute(event.data)
      if (route === undefined) return
      // The sidebar shell is what this webview loads, so its wider face is
      // available; ctx.layout's declared type is the narrower shared contract.
      ;(ctx.layout as NarrowLayoutService).show(route)
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, 'dsh-vscode: host route bridge')
}
