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

/** Webview → extension host readiness after the route listener is installed. */
export interface WebviewReadyMessage {
  type: 'dsh-webview-ready'
}

/** Extension host → webview readiness after the managed server accepts HTTP. */
export interface WebviewHostReadyMessage {
  type: 'dsh-host-ready'
}

/** Bootstrap-owned route channel, with latest-value replay for late subscribers. */
export interface WebviewRouteChannel {
  receive(data: unknown): boolean
  subscribe(listener: (route: NarrowRoute) => void): () => void
}

declare global {
  var __DSH_WEBVIEW_ROUTES__: WebviewRouteChannel | undefined
}

/** Narrow an incoming window message to a route command. */
export function asRoute(data: unknown): NarrowRoute | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const message = data as Partial<RouteMessage>
  if (message.type !== 'dsh-route') return undefined
  return message.route === 'chat' || message.route === 'sessions' || message.route === 'details'
    ? message.route
    : undefined
}

/** Create the page-lifetime route channel used by bootstrap and the plugin. */
export function createWebviewRouteChannel(): WebviewRouteChannel {
  const listeners = new Set<(route: NarrowRoute) => void>()
  let latest: NarrowRoute | undefined
  return {
    receive(data) {
      const route = asRoute(data)
      if (route === undefined) return false
      latest = route
      for (const listener of [...listeners]) listener(route)
      return true
    },
    subscribe(listener) {
      listeners.add(listener)
      if (latest !== undefined) listener(latest)
      return () => { listeners.delete(listener) }
    },
  }
}

/** Narrow a webview readiness message. */
export function isWebviewReadyMessage(data: unknown): data is WebviewReadyMessage {
  return typeof data === 'object' && data !== null
    && (data as Partial<WebviewReadyMessage>).type === 'dsh-webview-ready'
}

/** Narrow a managed-server readiness message. */
export function isWebviewHostReadyMessage(data: unknown): data is WebviewHostReadyMessage {
  return typeof data === 'object' && data !== null
    && (data as Partial<WebviewHostReadyMessage>).type === 'dsh-host-ready'
}

/** Required services: the shell's layout face carries the routing verbs. */
export const inject = ['layout']

/**
 * Client plugin body: relay host route commands onto the narrow shell.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const routes = globalThis.__DSH_WEBVIEW_ROUTES__
  if (routes === undefined) throw new Error('dsh-vscode routes: bootstrap channel missing')
  ctx.effect(() => {
    return routes.subscribe((route) => {
      // The sidebar shell is what this webview loads, so its wider face is
      // available; ctx.layout's declared type is the narrower shared contract.
      ;(ctx.layout as NarrowLayoutService).show(route)
    })
  }, 'dsh-vscode: host route bridge')
}
