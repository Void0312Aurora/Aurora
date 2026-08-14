/**
 * Browser wire client. The plugin selects fixture or HTTP transport, provides
 * the shared API client, and lets the runtime object layer start the stream
 * controller with its sinks.
 */
import type { Context } from 'cordis'
import type { IApiClient } from './api.ts'
import { ConnectionController, type ConnectionConfig, type ConnectionSinks, type ConnectionState } from './connection.ts'
import { FixtureApiClient } from './fixture.ts'
import { WebApiClient } from './web-api-client.ts'
import { PostMessageApiClient } from './webview-bridge.ts'
import { isLoopbackHostname } from '../loopback-hostname.ts'

// ---- Contract re-exports (browser-safe apiproxy channels + core types) ----
export type {
  ApiProxy, SessionsApi, SessionSearchItem, SessionSummary, HostApi, EventsApi, MuxFrame, HostFrame,
  ApprovalResponsePayload, QuestionResponsePayload, HistoryEntry, ToolEventView,
  DirectoryEntry, DirectoryListing,
  ToolCallView, ToolResultView, WorkspaceApi, WorkspaceId, WorkspaceView,
  CommandsApi, CommandDescriptor, SkillsApi, SkillEntry,
  ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  InboxItemId, ModelReasoningEffort, ModelTarget, QueueAction, QueuedInboxItem, SessionModels,
  SubagentsApi, SubagentAddress, SubagentCatalog, SubagentListEntry, SubagentPromptReceipt,
  RpcRequest, RpcResponse, RpcResult, RpcError, RpcErrorCode,
  ClientRequest, ServerResponse, ServerRequest, ClientResponse, RpcMessage, RpcReceipt,
  IApiClient, SessionId, SessionEvent, ContentBlock, StreamChunk,
  GoalsApi, GoalRef,
  SettingsApi, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView,
  CredentialsApi, CredentialView, ConfigurableProviderView, LlmApi,
} from './api.ts'
export {
  RpcId,
  AbstractApiClient,
  transportError,
} from './api.ts'
export { PostMessageApiClient } from './webview-bridge.ts'
export type { BridgeRequestMessage, BridgeResponseMessage, WebviewBridgePort } from './webview-bridge.ts'

// Connection loop types are public through ConnectionHandle.start; the
// controller remains package-internal.
export type { ConnectionConfig, ConnectionSinks, ConnectionState }


/** Required services (none — this is the wire root). */
export const inject: string[] = []

/**
 * The ctx.connection service surface: the api client plus a one-shot
 * controller starter (the runtime plugin supplies sinks when its object layer
 * is ready — connection stays consumer-agnostic).
 */
export interface ConnectionHandle {
  /** Shared api client (fixture or real, decided at boot from the page URL). */
  readonly api: IApiClient
  /** Whether the current page authority is loopback; non-browser contexts default to true. */
  readonly isLoopback: boolean
  /**
   * Start the connect/pump/reconnect loop with the consumer's frame sinks.
   * One consumer owns the streams (the runtime object layer); a second call
   * throws.
   * @param sinks - frame/state callbacks.
   * @param config - reconnect/backoff tunables.
   * @returns stop handle for the loop.
   */
  start(sinks: ConnectionSinks, config?: ConnectionConfig): { stop(): void }
}

/**
 * Client plugin body: pick the api by page mode and provide ctx.connection.
 * Selection order: an embedder webview bridge port (filled by the hosting
 * bootstrap before boot) wins, then the `?fixture` page switch, then the
 * same-origin HTTP client.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const bridgePort = globalThis.__DSH_WEBVIEW_BRIDGE__
  const fixture = pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('fixture')
  const api: IApiClient = bridgePort !== undefined
    ? new PostMessageApiClient(bridgePort)
    : fixture
      ? new FixtureApiClient()
      : new WebApiClient()
  let started = false
  const handle: ConnectionHandle = {
    api,
    // A bridged webview reaches the server through the extension host's own
    // loopback fetch, so it carries loopback capability regardless of the
    // page authority (the embedder origin is never the wire authority).
    // Fixture mode has no host behind it even when the page itself is served
    // from loopback; host-only interactions must use their in-memory fallback.
    isLoopback: bridgePort !== undefined
      || pageLocation === undefined
      || (!fixture && isLoopbackHostname(pageLocation.hostname)),
    start(sinks, config) {
      if (started) throw new Error('connection: the stream loop is already owned by another consumer')
      started = true
      const controller = new ConnectionController(api, sinks, config ?? {})
      controller.start()
      return { stop: () => { controller.stop() } }
    },
  }
  ctx.provide('connection', handle)
}
