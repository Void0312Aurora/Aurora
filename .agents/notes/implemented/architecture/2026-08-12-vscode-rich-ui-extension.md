# Agent Note: dsh-vscode — the rich-UI VS Code panel

Status: implemented

English | [中文](2026-08-12-vscode-rich-ui-extension.zh.md)

> Scope: a new product assembly `apps/vscode` (`@deepseek-ai/dsh-vscode`) that hosts the full DeepSeek Harness Web GUI inside a VS Code webview panel — one managed `dsh web` per window, the complete dsh client stack bundled statically into the webview, and a postMessage↔fetch bridge across the extension-host boundary. This note owns the panel/server/bridge foundation; [native interactions](2026-08-12-vscode-native-interactions.md) and [editor context injection](2026-08-12-vscode-ide-context-injection.md) own their editor-side integrations.

> Relationship to the community `dsh-external/dsh-vscode`: that extension is a native VS Code Chat Participant (`@dsh`) that deliberately ships no trajectory page and no embedded Web UI. This assembly occupies the opposite point — it keeps the rich GUI (Plan Mode, trajectory, slot-based tool cards, settings) by hosting the real client stack. The two are complementary and share only the `dsh web` server contract.

## Problem

The Web GUI is the product's richest surface, and the desktop shell already proved a client shell can own a `dsh web` server's lifecycle. VS Code users want that GUI beside their editor with editor-native affordances. A webview is a browser, so the GUI can run there unchanged in principle — but two facts block a naive port. First, a webview's page origin is `vscode-webview://…`, which the server's `/api` browser-trust fence refuses (the fence demands a loopback Host or a same-origin `Origin`; DNS-rebinding defense is the whole point). Second, a webview's CSP forbids fetching plugin bundles from the server, so the client module system's default fetch-a-bundle-per-plugin loading cannot run.

## Decision

**The extension host owns the server and proxies every `/api` byte; the webview never touches the network.** `ServerRuntime` (`apps/vscode/src/runtime.ts`) spawns `dsh web --host 127.0.0.1 --port 0` through the shared `@deepseek-ai/dsh-web-launcher` primitive — the same resolution/readiness/HTTP-poll logic the desktop shell uses — and tree-kills it through `@deepseek-ai/dsh-process-tree`. Each startup attempt owns its exact child and listeners; any failure after spawn tears that child down before a retry can replace it. `RuntimeLifecycle` (`apps/vscode/src/lifecycle.ts`) owns the current generation, keeps the panel alive across restart, and exposes a current-origin resolver used by both `ApiBridge` and the native wire clients, so no consumer retains a disposed server. The webview's `PostMessageApiClient` (`packages/client/connection`, a third platform subclass beside Web and Fixture) posts each request over the embedder port; `ApiBridge` (`apps/vscode/src/bridge.ts`) replays it against the current loopback origin. A loopback Host passes the fence like any non-browser client, so nothing about the fence changes — the bridge is the reason the GUI reaches the server at all, and it reports `isLoopback: true` because the extension host's fetch, not the webview page, is the wire client.

**The GUI is bundled statically and booted through the unchanged shell kernel.** `AppWebEntry` gained one seam — a `staticPlugins` map registered through the module system's existing `registerStatic` path — so the webview can hand it every plugin implementation at build time instead of a fetch graph. `webview/vite.config.ts` bundles the roster (the `dshClient` rows of `apps/cli/config/web.cordis.yml` minus dev-only hmr, plus a VS Code theme adapter) into one asset pair served through `asWebviewUri` under a strict CSP (`script-src` pinned to the extension's asset origin, no inline scripts). The theme adapter maps the editor's `--vscode-*` variables onto the client's `--dsw-alias-*` tokens through the existing `ThemeService.register()`, so the GUI follows the editor's color theme.

**The window is the isolation unit.** One current `ServerRuntime` per window (`--port 0` guarantees no collision between windows or with a standalone `dsh web`); the first workspace folder is the server cwd, so the harness adopts it as the default project root. Startup remains asynchronous, and the webview's connection loop reconnects when the server becomes ready or a restart publishes its replacement.

## Alternatives considered

- **VS Code Chat Participant (the community `dsh-vscode` route)** — native and light, but the Chat API cannot express the rich GUI (trajectory, Plan Mode, slot tool cards); that extension states the omission outright. Rejected here precisely because the rich GUI is this assembly's reason to exist.
- **Webview fetches the server directly** — impossible: the `vscode-webview://` origin fails the `/api` trust fence, and relaxing the fence for it would reopen the DNS-rebinding hole the fence closes.
- **Fetch plugin bundles at runtime (the browser shell's default)** — the webview CSP forbids remote script and inline execution; a static single bundle is the CSP-clean shape, and it also removes the server round-trips the browser shell pays at boot.
- **Reuse the desktop Electron shell inside VS Code** — VS Code is its own Electron host; a nested shell cannot mount. The reusable part is the launcher, which is why it moved to a shared package rather than being copied.

## Consequences

The launcher extraction made `apps/desktop` a consumer of `@deepseek-ai/dsh-web-launcher`. The `PostMessageApiClient`, the `AppWebEntry` static-plugins seam, and the theme adapter are covered keyless; extension-host tests cover failed-start cleanup, restart/origin rebinding, the relay, panel CSP, and roster parity. `pnpm run test:vscode:electron` loads the built `dist/extension.js` in an isolated Extension Development Host, opens the assembled panel against a deterministic local server, verifies context injection and a native approval, restarts the server, and compares the user-visible outcome snapshot. The host bundle inlines workspace runtime imports while leaving only `vscode` and Node built-ins external. The extension still depends on the launcher resolving a `dsh` through `DSH_BIN`, a checkout, or PATH; a machine with none receives a start error in the panel.
