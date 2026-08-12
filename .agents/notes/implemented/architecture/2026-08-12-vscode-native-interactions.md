# Agent Note: dsh-vscode native interactions and editor-target resolution

Status: implemented

English | [中文](2026-08-12-vscode-native-interactions.zh.md)

> Scope: the editor-native layer of `apps/vscode` on top of the [panel/server/bridge foundation](2026-08-12-vscode-rich-ui-extension.md) — a host-side mux-stream consumer that answers the agent's approval and question requests through VS Code prompts, and a pure resolver that turns a tool view's model-facing paths into absolute editor targets and whole-file diff panes.

## Problem

The webview GUI already renders approvals, questions, and tool diffs in-panel. But an editor user often is not looking at the panel: an approval that blocks the agent should be answerable from a native notification, and a question from a QuickPick, without hunting for the panel tab. Separately, the rich value of an IDE is opening the agent's edits in the real diff editor and jumping to the lines it touched — and the wire gives neither directly: an `approval/requested` frame names only a tool, result-side diffs are 3-line-context hunk fragments rather than whole files, and every path is model-facing (relative to the session cwd), not an editor URI.

## Decision

**The extension host drives its own wire client, not a second webview.** `LoopbackApiClient` (`apps/vscode/src/host-client.ts`) is a thin `AbstractApiClient` subclass whose `resolveBase()` returns the managed server's current origin and whose `doFetch` is global fetch. Because the extension host is not a browser, a loopback Host clears the `/api` browser-trust fence with no fence change — the same reason the bridge exists, applied directly. This reuses every protocol invariant (rpcId, envelope, zod, SSE decode, `respond`) for free.

**`NativeInteractions` (`apps/vscode/src/interactions.ts`) consumes the mux stream and answers through injected UI.** It caches `tool/call` frames (name plus the call view that rides the frame) so an approval prompt shows what the call will do — the approval frame itself carries only `toolName`/`callId`. Answers respond on the request's **envelope** rpcId (not a payload field): both approvals and questions echo the stream envelope's rpcId, while a later `*/resolved` frame correlates by the approvalId (approvals) or the same request rpcId (questions), which is why the pending map keys and the respond id are tracked separately. A prompt still open when the request resolves elsewhere is closed through its abort signal — multi-client coexistence with the webview, first answer wins, the loser gets a harmless `not-pending` receipt. Reconnection just reopens the stream; the host replays still-pending approval/question frames on open, so this surface needs no history reconciliation (that is the webview's ConnectionController's job).

**Path and diff math is a pure module.** `apps/vscode/src/locations.ts` resolves model-facing paths against the session cwd (`editorTargets`) and reconstructs whole-file diff panes (`diffMaterials`): the left pane is the current on-disk text for an edit (falling back to the hunk's `oldText` when unreadable) and empty for a create/overwrite, the right pane is the model's resulting text. Keeping this pure keeps the vscode-coupled `vscode.diff`/`showTextDocument` glue thin and lets the resolution be tested keyless.

## Alternatives considered

- **Answer only through the webview** — leaves an agent blocked on an approval unanswerable unless the user finds the panel; the native prompt is the point of an editor integration.
- **A second full webview client for the extension host** — the host is Node; it needs only the wire client, not React or the slot system. `LoopbackApiClient` is ~20 lines over the shared base.
- **Suppress the webview prompt while the native one is up** — needs cross-surface coordination the wire does not offer and the panel may not even be open; multi-client first-answer-wins is already correct, so v1 lets both show and documents it.
- **Whole-file diffs over the wire** — would bloat every tool result with full file bodies the model never needs; reconstructing from disk on demand keeps the wire lean and is exactly what an editor can do that a remote GUI cannot.

## Consequences

`NativeInteractions` runs automatically with the panel; approvals and questions become native prompts beside the in-panel ones. Its frame handling — cache enrichment, envelope-rpcId responses, resolve-elsewhere closing, dismissed-sends-nothing, reconnect-replays — is covered keyless over a fake client and fake UI (`apps/vscode/tests/interactions.spec.ts`); the path/diff resolver over injected disk reads (`apps/vscode/tests/locations.spec.ts`). What is deliberately deferred: opening a native diff editor or revealing a location has its resolver foundation but no trigger, because the trigger is a client-side "open in editor" signal from a tool card — a client-plugin change that belongs to a dedicated UI phase. IDE context injection (`session.injectContext`, already on the wire) is the next phase's sampling work. The vscode-coupled glue (the notification/QuickPick adapter in `extension.ts`) stays untested by the same rule the panel HTML resolver follows — pure logic is tested, the `vscode` module boundary is not.
