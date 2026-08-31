# Agent Note: wire protocol version and IDE context injection

Status: implemented

English | [中文](2026-08-12-wire-protocol-version-and-ide-context-injection.zh.md)

> Scope: two additions to the `/api` wire contract (`packages/host/apiproxy`) that the independently released VS Code extension needs: the `protocolVersion` field on `host.describe`, and the `session.injectContext` unary method with its `ide-context` message-source member.

## Problem

The `/api` contract was written for clients that ship with the host (the browser GUI, the desktop shell), so `host.ts` deliberately carried no protocol version — its header reserved one "only when an independently released client appears". The VS Code rich-UI extension is that client: it is installed from a marketplace, meets arbitrary host versions, and must fail loudly on an incompatible wire instead of consuming frames it misparses. The extension also needs to feed editor state (active file, selection, diagnostics) to the model of a long-lived session *between* prompts. `session.prompt` cannot carry it: both its modes (`queue`/`steer`) wake the model, and its `user` source presents the content as a user utterance. The host already owns the right primitive — `Agent.inject()`, the next-step/no-wakeup preset that appends a durable sourced `user/message` — but nothing exposed it on the wire.

## Decision

**`host.describe` now returns `protocolVersion` (the `API_PROTOCOL_VERSION` constant in `api/host.ts`, starting at 1).** Independently released clients gate on it during their connection handshake; in-repo clients ship with the host and ignore it. Any breaking change to methods, payloads, or frame shapes bumps the constant in the same PR.

**`session.injectContext` is the wire face of `Agent.inject()`.** The payload is `{ sessionId, content: ContentBlock[] }` (non-empty; no mode field — injection has exactly one behavior). The gateway resolves the agent through the same `agentFor` path as `session.prompt` (subagent fencing and cold resume included) and calls `agent.inject(createUserMessage({ content, source }))`. Slash commands are never dispatched — injection is context, not input. Errors map like prompt's: a synchronous inject throw becomes the stable `agent-busy` code.

**Provenance is the new `ide-context` member of `MessageSourceMap`** (declaration-merged in `api/sessions.ts`, the same pattern as `user-rpc`): `{ kind: 'plugin'; plugin: 'ide'; rpcId }`. `kind` stays `plugin` because to the model this is environment context like any host context plugin's — the model face carries no transport vocabulary; the fixed `'ide'` tag distinguishes wire injection from host-plugin injection in the durable log; the request's rpcId is the audit/reconciliation field.

## Alternatives considered

- **Prompt-embedded context (the dsh-vscode chat-participant approach)** — format editor state into every user prompt. Correct for a per-turn chat participant, wrong for a resident webview client: between-prompt editor changes would be invisible until the user happens to send a message, and the context would masquerade as user words in the durable log.
- **A host-side `ide-context` plugin fed over a side channel** — keeps the wire untouched but the extension lives in another process, so the side channel would itself be a new wire; the RPC is that channel, minus a bespoke protocol.
- **A semver string instead of an integer protocolVersion** — the contract's compatibility unit is "can this client consume this wire at all"; a single integer answers exactly that, and the api-contracts prose owns the change log.

## Consequences

The handler's compiler-locked tables (`rpc-map.ts`, `UNARY_ROUTES`, `UNARY_VALUE_SCHEMAS`) forced every carrier surface to acknowledge the new method — the fixture client (`packages/client/connection/src/client/fixture.ts`) implements it as an idle no-wakeup append, so keyless web lanes exercise the frame shape. Gateway routing, provenance, and error mapping are covered by `packages/host/apiproxy/tests/api-proxy-inject.spec.ts`; the wire round-trip by `fetch-carrier.spec.ts`; schema acceptance/rejection by `rpc-schemas.spec.ts`. The no-wakeup/staging semantics of injection itself remain the agent-loop suites' property. The shipped caller is the VS Code extension's IDE-context feed (`apps/vscode`), which injects the active editor context into the active session; end-to-end coverage through a booted webview lands with that extension's deferred `@vscode/test-electron` lane.
