# Agent Note: dsh-vscode IDE context injection

Status: implemented

English | [中文](2026-08-12-vscode-ide-context-injection.zh.md)

> Scope: the editor-context feed of `apps/vscode` — a debounced sampler that reads the active editor (file, selection or cursor window, diagnostics), suppresses no-op updates, and injects a bounded reading into the active session over `session.injectContext`. Built on the [wire method](2026-08-12-wire-protocol-version-and-ide-context-injection.md) and the [native-interactions client](2026-08-12-vscode-native-interactions.md).

## Problem

An editor user expects to say "fix this file" or "why does this fail" and have the agent know what "this" is, without pasting. The model only knows what the session log carries, so the extension must feed editor state into the session. Three constraints shape it: the feed must not wake the model (editor movements are context, not prompts), it must not flood the session with a reading on every keystroke or idle cursor jitter, and it must target the session the user is actually chatting in — which the webview owns, not the extension host.

## Decision

**Sampling and change-suppression are a pure module; the feed and its VS Code wiring are thin.** `apps/vscode/src/ide-context.ts` turns a plain `EditorState` (built by the extension from the VS Code API) into a bounded `IdeContextSnapshot`: a model-facing reading plus a `signature` that keys change detection (the signature is the rendered text itself, so two samples that render identically after every bound are a no-op). Bounds apply at every level — selection/window characters, diagnostic count, a per-diagnostic message cap, and a final cap on the complete rendered reading. `apps/vscode/src/context-feed.ts` debounces editor nudges, samples, suppresses an unchanged per-session signature, and serializes `session.injectContext` calls through one queue so completions cannot land out of order. Its `beforeFirstPrompt(sessionId)` path provides a per-session single-flight admission attempt. `ApiBridge` is the ordering choke point: before relaying a valid `session.prompt`, it awaits that explicit session's admission; the active-session notification and prompt race therefore share one Promise. A rejected or failed injection is logged and releases the prompt without recording the signature, so later editor nudges can retry. Keeping the pure core out of the `vscode` module lets bounds, debounce, explicit-session ordering, serialization, suppression, per-session signature memory, and retry-on-rejection all be tested keyless.

**The target session is tracked host-side from the event stream.** `apps/vscode/src/active-session.ts` follows the host stream and remembers the most recently running session (the strongest "user is here" signal), falling back to the first session it sees so a fresh single-session window has a target before any turn runs. An active-session change fires `onActiveChanged`, which the extension wires to forget the previous session's signature and nudge the feed — the current editor context is new to the newly active session, so it gets a reading without waiting for the next editor movement. This is a heuristic: the webview owns true session selection, and until a webview→host active-session signal exists, "last running" is correct for the common single-session flow and approximate when several sessions are attached.

## Alternatives considered

- **Embed editor context in every prompt (the dsh-vscode chat-participant approach)** — correct for a per-turn chat participant, wrong here: a resident panel's editor changes between prompts would be invisible until the user sends a message, and the context would read as user words in the log rather than environment context. The no-wakeup inject is exactly the right primitive.
- **Inject on a timer** — a fixed cadence either lags real edits or floods idle ones; debounced editor events with signature suppression track actual change.
- **Inject into every attached session** — noisy and wrong; a reading meant for the chat the user is in should not appear in unrelated sessions. The host-side active-session heuristic bounds it to one.
- **Wait for the webview active-session signal before shipping any injection** — that signal is a client-plugin change; the host-side heuristic delivers a working single-session v1 now and refines later without reworking the feed.

## Consequences

Editor movements feed the active session bounded context that a prompt can refer to, without waking the model and without flooding it. The whole native layer starts only after the extension host verifies the server's `protocolVersion` against its own. The sampler (`ide-context.spec.ts`), serialized feed (`context-feed.spec.ts`), active-session tracker (`active-session.spec.ts`), and bridge barrier (`bridge.spec.ts`) are covered keyless over injected state, client, scheduler, and deferred relay. The assembled `@vscode/test-electron` lane opens a file before activating the built extension, drives a prompt through the built webview and production `dsh web` composition with a replayed LLM, and reads the production JSONL to require IDE context before the user prompt and first request header. The known approximation applies only to background editor nudges when multiple sessions are attached; the first bridged prompt uses its explicit session. Bounds (`maxTextChars`, `maxDiagnostics`, the per-diagnostic and total caps, and the cursor window) are fixed constants for v1; they become settings when the extension grows a settings surface.
