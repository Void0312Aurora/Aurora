# Agent Note: Public baseline desktop and VS Code shells

Status: implemented

English | [中文](2026-08-15-public-baseline-desktop-and-vscode-shells.zh.md)

## Problem

The Electron desktop and VS Code products need the same runtime contracts, package graph, and release baseline as the public `dsh` CLI. Maintaining them against a private snapshot makes package renames, Cordis scope changes, web-client composition, and deploy closures drift independently. A VS Code webview also cannot call the managed loopback server directly because its origin is not the server origin, while editor context must enter a session without waking the model.

## Decision

`apps/desktop` and `apps/vscode` live in the public-baseline monorepo as private product assemblies. Both launch the repository's `dsh web` command and carry a dependency-only closure whose workspace dependencies match the current CLI, web, and SDK runtime graph. The workspace includes both closure roots explicitly, and product builds create the web frontend before deployment so the packaged closure contains `@deepseek-ai/dsh-web-frontend/dist`.

Process ownership is shared below the products. `@deepseek-ai/dsh-web-launcher` resolves and spawns `dsh web`, handles Windows command shims, parses the readiness line, polls HTTP readiness, and owns launch cancellation. `@deepseek-ai/dsh-process-tree` owns whole-tree termination. The Electron and VS Code hosts consume these packages instead of maintaining separate subprocess implementations.

The VS Code webview statically bundles its client plugin roster and passes it through `AppWebEntry`'s `staticPlugins` option. Its connection client selects `PostMessageApiClient` when the bootstrap installs `globalThis.__DSH_WEBVIEW_BRIDGE__`; the extension host confines every relayed request to the managed server's exact origin and `/api/` path prefix before fetching it. The normal browser and fixture transports remain unchanged when that bridge is absent.

The independently packaged extension validates `host.describe.protocolVersion` against `API_PROTOCOL_VERSION`. Protocol version `1` covers the bridge-consumed API and frame shapes. The Webview bridge withholds the managed origin until this probe succeeds, and the client connection opens event streams only after the same check, so missing or incompatible versions cannot reach a frame consumer. Breaking wire changes increment the constant; the application package version is not the compatibility signal.

Editor context uses `session.injectContext`. The host validates a non-empty `ContentBlock[]`, resolves an ordinary session Agent, and calls `Agent.inject()` with fixed `ide` plugin provenance plus the originating request `rpcId`. This appends durable model-facing context without starting a turn or dispatching slash commands. Session-backed subagents retain their existing ownership rejection.

## Alternatives considered

**Keep the shells in a separate downstream repository.** This preserves repository isolation but repeats every package rename and runtime contract migration, and it cannot use workspace checks to prove that the packaged products match the public CLI graph.

**Let the webview call the loopback server directly.** The webview origin fails the browser trust boundary, and weakening that boundary would broaden the server's attack surface. A confined extension-host relay preserves the boundary without granting arbitrary loopback fetch capability.

**Use the package version as the wire compatibility check.** Product versions change for reasons unrelated to protocol shape and do not identify breaking API changes precisely. A dedicated integer protocol version keeps the compatibility decision explicit.

**Send editor context as an ordinary prompt.** A prompt may wake the model, enter queue or steering semantics, and dispatch commands. `Agent.inject()` preserves the required no-turn behavior and durable provenance.

## Consequences

The product shells now move with the public source baseline and share launcher, process-tree, API, and client boot contracts. Their package and closure metadata use the root release line and MIT license. The cost is a larger workspace graph and an explicit protocol-bump obligation whenever an independently released client would observe a breaking wire change.

Host and client TypeScript project builds cover the shared contracts; focused tests cover protocol rejection, `session.injectContext` routing and rpcId provenance, malformed bridge traffic, duplicate ids, streamed response reconstruction, and cancellation before and after the response head; the CI artifact gate runs built-entry tests and production-CSP Webview acceptance after the root and product builds; closure deployment checks prove that each packaged runtime contains the built web frontend.
