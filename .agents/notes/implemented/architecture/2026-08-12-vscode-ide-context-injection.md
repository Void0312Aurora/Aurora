# Agent Note: dsh-vscode IDE context injection

Status: implemented

English | [中文](2026-08-12-vscode-ide-context-injection.zh.md)

> Scope: the editor-context feed of `apps/vscode` — a debounced sampler that reads the active editor (file, selection or cursor window, diagnostics), suppresses no-op updates, and injects a bounded reading into the active session over `session.injectContext`. Built on the [wire method](2026-08-12-wire-protocol-version-and-ide-context-injection.md) and the [native-interactions client](2026-08-12-vscode-native-interactions.md).

## Problem

An editor user expects to say "fix this file" or "why does this fail" and have the agent know what "this" is, without pasting. The model only knows what the session log carries, so the extension must feed editor state into the session. Three constraints shape it: the feed must not wake the model (editor movements are context, not prompts), it must not flood the session with a reading on every keystroke or idle cursor jitter, and it must target the session the user is actually chatting in — which the webview owns, not the extension host.

## Decision

**Sampling and change-suppression are a pure module; the feed and its VS Code wiring are thin.** `apps/vscode/src/ide-context.ts` turns a plain `EditorState` (built by the extension from the VS Code API) into a bounded `IdeContextSnapshot`: a model-facing reading plus a `signature` that keys change detection. `apps/vscode/src/context-feed.ts` debounces editor nudges, samples, drops a snapshot whose signature equals the last one it injected for that session, and calls `session.injectContext` — the no-wakeup wire method, so the reading stages for the session's next step and never starts a turn. Its `sync()` path cancels a pending debounce and samples immediately when a session first becomes active. Keeping the pure core out of the `vscode` module lets debounce, immediate sync, suppression, per-session signature memory, and retry-on-rejection all be tested keyless.

**The target session is tracked host-side from the event stream.** `apps/vscode/src/active-session.ts` follows the host stream and remembers the most recently running session (the strongest "user is here" signal), falling back to the first session it sees so a fresh single-session window has a target before any turn runs. It reports active-session changes to the feed, which immediately injects the current reading. The extension retains the last valid editor state while its panel owns focus, so opening the panel between editor sampling and session discovery does not erase the file that should be injected. Session selection remains a heuristic: the webview owns true selection, and until a webview→host active-session signal exists, "last running" is correct for the common single-session flow and approximate when several sessions are attached.

## Alternatives considered

- **Embed editor context in every prompt (the dsh-vscode chat-participant approach)** — correct for a per-turn chat participant, wrong here: a resident panel's editor changes between prompts would be invisible until the user sends a message, and the context would read as user words in the log rather than environment context. The no-wakeup inject is exactly the right primitive.
- **Inject on a timer** — a fixed cadence either lags real edits or floods idle ones; debounced editor events with signature suppression track actual change.
- **Inject into every attached session** — noisy and wrong; a reading meant for the chat the user is in should not appear in unrelated sessions. The host-side active-session heuristic bounds it to one.
- **Wait for the webview active-session signal before shipping any injection** — that signal is a client-plugin change; the host-side heuristic delivers a working single-session v1 now and refines later without reworking the feed.

## Consequences

Editor movements feed the active session bounded context that a prompt can refer to, without waking the model and without flooding it. The sampler (`ide-context.spec.ts`), feed (`context-feed.spec.ts`), and active-session tracker (`active-session.spec.ts`) are covered keyless over injected editor state, client, and scheduler. The assembled `@vscode/test-electron` lane opens a file before activating the built extension, waits for session discovery, and verifies durable context injection before exercising native approval and restart. The known approximation is the injection target when multiple sessions are attached; the README records it, and a webview→host active-session signal remains the refinement. Bounds (`maxTextChars`, `maxDiagnostics`, the cursor window) are fixed constants in `extension.ts` for v1; they become settings when the extension grows a settings surface.
