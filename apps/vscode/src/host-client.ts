/**
 * Extension-host wire client. The extension host is not a browser, so it can
 * drive the server's `/api` directly: a loopback Host passes the browser-trust
 * fence like any non-browser client. This subclass reuses every protocol
 * invariant of `AbstractApiClient` (rpcId minting, envelope wrap, zod parse,
 * SSE decode, `respond`) and supplies only the transport — global fetch against
 * the current server origin, which moves each time the managed server restarts.
 */

import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import { API_PROTOCOL_VERSION } from '@deepseek-ai/dsh-host-apiproxy/api'

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

/** Outcome of the independently released extension/host protocol probe. */
export type ProtocolCheck =
  | { ok: true; hostVersion: string }
  | { ok: false; reason: string }

/**
 * Verify the host wire version before opening native event streams. The
 * extension can reach a user-selected DSH_BIN, so a ready HTTP port alone is
 * not sufficient to establish that the native client and host agree.
 * @param client - a loopback client whose origin is already ready.
 * @param signal - optional cancellation signal.
 * @returns the compatibility result.
 */
export async function verifyHostProtocol(
  client: Pick<AbstractApiClient, 'host'>,
  signal?: AbortSignal,
): Promise<ProtocolCheck> {
  const response = await client.host.describe({}, signal)
  if (!response.result.ok) {
    return { ok: false, reason: `host.describe failed: ${response.result.error.code}` }
  }
  const { protocolVersion, version } = response.result.value
  if (protocolVersion !== API_PROTOCOL_VERSION) {
    return { ok: false, reason: `host protocolVersion ${String(protocolVersion)} != client ${API_PROTOCOL_VERSION}` }
  }
  return { ok: true, hostVersion: version }
}
