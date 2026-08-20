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

/** Outcome of the independently-released-client protocol handshake. */
export type ProtocolCheck =
  | { ok: true; hostVersion: string }
  | { ok: false; reason: string }

/**
 * Gate an independently released client against the host it connected to. The
 * extension ships a bundled server, but may instead reach a `DSH_BIN`/PATH
 * `dsh` of a different version; this reads `host.describe` and requires its
 * `protocolVersion` to equal {@link API_PROTOCOL_VERSION}, so a mismatch fails
 * loud (the wire note's whole reason for the version field) rather than
 * letting the host-side native layer misparse frames.
 * @param client - a started host client.
 * @param signal - optional abort for the probe.
 * @returns whether the host's protocol matches this client's.
 */
export async function verifyHostProtocol(
  client: Pick<AbstractApiClient, 'host'>,
  signal?: AbortSignal,
): Promise<ProtocolCheck> {
  let response: Awaited<ReturnType<AbstractApiClient['host']['describe']>>
  try {
    response = await client.host.describe({}, signal)
  } catch (error: unknown) {
    return { ok: false, reason: `host.describe protocol response invalid: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!response.result.ok) {
    return { ok: false, reason: `host.describe failed: ${response.result.error.code}` }
  }
  const { protocolVersion, version } = response.result.value
  if (protocolVersion !== API_PROTOCOL_VERSION) {
    return { ok: false, reason: `host protocolVersion ${String(protocolVersion)} != client ${String(API_PROTOCOL_VERSION)}` }
  }
  return { ok: true, hostVersion: version }
}
