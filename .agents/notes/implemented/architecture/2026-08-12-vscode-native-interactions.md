# Agent Note: dsh-vscode native interactions

Status: implemented

English | [中文](2026-08-12-vscode-native-interactions.zh.md)

> Scope: the editor-native interaction layer of `apps/vscode` on top of the [panel/server/bridge foundation](2026-08-12-vscode-rich-ui-extension.md) — a host-side mux-stream consumer that answers the agent's approval and question requests through cancellable VS Code controls.

## Problem

The webview GUI already renders approvals and questions in-panel, but an editor user often is not looking at the panel. An approval that blocks the agent should be answerable from a native control, and a question from a QuickPick or input box, without hunting for the panel tab. The `approval/requested` frame names only a tool, so the native surface also needs the matching call presentation without confusing equal call ids from different sessions.

## Decision

**The extension host drives its own wire client, not a second webview.** `LoopbackApiClient` (`apps/vscode/src/host-client.ts`) is a thin `AbstractApiClient` subclass whose `resolveBase()` returns the managed server's current origin and whose `doFetch` is global fetch. Because the extension host is not a browser, a loopback Host clears the `/api` browser-trust fence with no fence change — the same reason the bridge exists, applied directly. This reuses every protocol invariant (rpcId, envelope, zod, SSE decode, `respond`) for free.

**`NativeInteractions` (`apps/vscode/src/interactions.ts`) consumes the mux stream and answers through injected UI.** It caches `tool/call` frames by session and call id, and uses a cached view only when its tool name also matches the approval. Answers respond on the request's **envelope** rpcId (not a payload field): approvals and questions echo the stream envelope's rpcId, while later `*/resolved` frames correlate by approval id or request rpcId. Every open control is owned by an `AbortController`; a resolved request or dropped stream generation closes it without sending a late answer, and a replayed unresolved request creates one control in the replacement generation. `apps/vscode/src/native-ui.ts` implements approvals as QuickPicks. Questions use tagged option/Other/Skip items; Other opens a validated input box, multi-select preserves ordinary selections beside custom text, and no synthetic label enters the Host answer. Controls and listeners are disposed on accept, hide, or abort.

## Alternatives considered

- **Answer only through the webview** — leaves an agent blocked on an approval unanswerable unless the user finds the panel; the native prompt is the point of an editor integration.
- **A second full webview client for the extension host** — the host is Node; it needs only the wire client, not React or the slot system. `LoopbackApiClient` is ~20 lines over the shared base.
- **Suppress the webview prompt while the native one is up** — needs cross-surface coordination the wire does not offer and the panel may not even be open; multi-client first-answer-wins is already correct, so v1 lets both show and documents it.

## Consequences

`NativeInteractions` runs automatically with the panel; approvals and questions become native prompts beside the in-panel ones. `interactions.spec.ts` covers session-scoped cache enrichment, tool-name verification, envelope-rpcId responses, resolve-elsewhere closing, dismissed-sends-nothing, and reconnect replay. `native-ui.spec.ts` exercises cancellation plus selected-only, custom-only, selected-and-custom, explicit-skip, and blank-retry answer shapes against fake VS Code controls. The assembled `@vscode/test-electron` lane owns the production CLI/webview round trip; native control protocol conformance remains in the deterministic host-side suite.
