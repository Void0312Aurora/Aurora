/**
 * Extension-host wire client. The extension host is not a browser, so it can
 * drive the server's `/api` directly: a loopback Host passes the browser-trust
 * fence like any non-browser client. This subclass reuses every protocol
 * invariant of `AbstractApiClient` (rpcId minting, envelope wrap, zod parse,
 * SSE decode, `respond`) and supplies only the transport — global fetch against
 * the current server origin, which moves each time the managed server restarts.
 */

import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'

/** Wire client whose base origin follows the managed server across restarts. */
export class LoopbackApiClient extends AbstractApiClient {
  /** @param origin - resolves the current server origin; undefined before readiness. */
  constructor(private readonly origin: () => URL | undefined) {
    super()
  }

  /** The base every request path resolves against — the live server origin. */
  protected override resolveBase(): string {
    const origin = this.origin()
    if (origin === undefined) throw new Error('dsh host client: no server origin yet')
    return origin.origin
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return fetch(input, init)
  }
}
