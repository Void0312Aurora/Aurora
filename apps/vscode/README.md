# `dsh-vscode`

English | [中文](README.zh.md)

VS Code extension hosting the full DeepSeek Harness Web GUI in an editor panel. It spawns one managed `dsh web` per window, hosts the complete dsh client stack in a webview, and bridges the webview's `/api` traffic to the server through the extension host. Unlike the lightweight chat-participant integration, this panel keeps the rich GUI intact: Plan Mode, the trajectory view, slot-based tool cards, and the settings pages.

## How it fits together

```text
webview (browser)            extension host (Node)             dsh web
  PostMessageApiClient  ──▶   ApiBridge  ──▶  loopback fetch  ──▶  /api
  full dsh client stack  ◀──  postMessage  ◀──  SSE/JSON  ◀──────  /api
```

The webview's page origin is `vscode-webview://…`, which the server's `/api` browser-trust fence refuses. So the webview never fetches the server directly: its transport (`PostMessageApiClient` from [`@deepseek-ai/dsh-client-connection`](../../packages/client/connection/README.md)) posts every request to the extension host, which replays it against the server's loopback origin — a loopback Host passes the fence like any non-browser client. The GUI itself is the ordinary dsh client stack, bundled statically by `webview/vite.config.ts` (the webview's CSP forbids fetching plugin bundles, so every plugin ships inside one bundle) and booted through the shared `AppWebEntry` kernel with the roster registered as static plugins.

The extension launches, on demand:

```sh
dsh web --host 127.0.0.1 --port 0
```

through the shared [`@deepseek-ai/dsh-web-launcher`](../../packages/util/web-launcher/README.md) primitive (the desktop shell uses the same one), which resolves `dsh` in the order `DSH_BIN` → embedded closure → checkout → PATH. `--port 0` means parallel windows never collide. The managed server is torn down (tree-killed) when the extension host deactivates.

## Native interactions

Beside the webview, the extension host opens its own mux stream (a plain loopback wire client — the extension host is not a browser, so it passes the `/api` trust fence directly) and surfaces the agent's **approval** and **question** requests as cancellable editor-native prompts: a QuickPick with Allow/Reject for approvals, and a QuickPick or input box for questions. An approval prompt is enriched with what the call will do from a cached `tool/call` view scoped by session, call id, and tool name. Because the wire is multi-client, this runs alongside the webview's in-panel prompts: whichever surface answers first wins, and a prompt still open when the request resolves elsewhere closes without sending a late answer.

## Editor context injection

The extension feeds the model your editor context so a prompt can refer to "this file" without pasting. On editor changes (active file, text, selection, diagnostics) a debounced sampler builds a bounded reading — the active file and range, the selection or a cursor window, and error/warning diagnostics — and injects it into the active session over `session.injectContext`, the no-wakeup wire method (it stages for the session's next step and never starts a turn on its own). A reading whose signature matches the last one sent is suppressed. When a session becomes active, the sampler injects immediately; it retains the last valid editor reading while the panel owns focus, so opening the panel does not lose the pre-existing file. The target session is tracked from the host stream (the most recently running session, else the first one seen); precise "the session the user is viewing" selection awaits a webview→host signal.

## Commands

- **DeepSeek Harness: Open Panel** — start the server (if needed) and reveal the GUI panel beside the editor.
- **DeepSeek Harness: Restart Server** — tree-kill and relaunch the managed server while retaining the panel; its bridge and native clients resolve the replacement origin dynamically.

## Windows

Windows has no harness confinement backend, so the CLI's default `workspace-write` permission mode cannot boot there. When `DSH_PERMISSION_MODE` is unset the launcher falls back to `danger-full-access` (approval prompts disabled) and logs a warning; set `DSH_PERMISSION_MODE` explicitly to override. This is the same fallback the desktop shell applies.

## Build

```sh
pnpm --filter dsh-vscode run build       # host bundle (tsdown) + webview bundle (vite)
pnpm --filter dsh-vscode run build:host  # extension host only
pnpm --filter dsh-vscode run build:webview
```

The host build emits one self-contained `dist/extension.js` (workspace runtime imports inlined; only the VS Code API and Node built-ins stay external). The webview build emits `dist/webview/webview.js` + `webview.css`, served through `asWebviewUri`.

## Package (self-contained vsix)

```sh
pnpm --filter dsh-vscode run package    # packs a vsix for the host platform
```

`package` runs the full repo build, materializes `deploy/` (the `dsh-vscode-closure` dependency-only deploy root — the same self-contained `dsh web` bundle the desktop shell ships), builds the extension, and runs `vsce package --no-dependencies` for the host platform through [scripts/package-vsix.mjs](scripts/package-vsix.mjs). `DSH_VSIX_TARGET` is an optional assertion for release jobs: it must equal the detected host target, because changing only the vsce label cannot replace the native addons already selected for `deploy/`. The vsix carries the runtime under `dist/`, `deploy/`, and `media/`, plus the extension manifest, readmes, and license retained by [.vscodeignore](.vscodeignore); no source or development `node_modules` tree ships. The top-level runtime-closure gate requires the desktop and VS Code dependency maps to remain identical.

The packaged extension needs no Node, no `dsh`, and no checkout: the launcher's embedded-closure branch runs the bundled CLI under **VS Code's own Electron as Node** (`ELECTRON_RUN_AS_NODE=1` with `--expose-internals`, exactly the desktop shell's mechanism, with `process.execPath` being the extension host's Electron). The closure's native addons (node-pty, koffi) are N-API and need no rebuild.

Because the closure carries platform-native addons, the vsix is **per-platform** (`vsce package --target <target>`); the release pipeline must run packaging on matching `win32-x64`, `linux-x64`, `darwin-x64`, `darwin-arm64`, and other supported runners. A dev checkout without `deploy/` falls through to the checkout's built CLI or `dsh` on PATH, so `pnpm --filter dsh-vscode run build` + an Extension Development Host works without packaging.

## Tests

`tests/` covers the extension-host logic keyless: process transactions (`runtime.spec.ts`), restart/origin rebinding (`lifecycle.spec.ts`), the postMessage↔fetch relay (`bridge.spec.ts`), cancellable native controls (`native-ui.spec.ts`), context targeting, panel HTML/CSP, and static-roster parity. `pnpm run test:vscode:electron` launches the built `dist/extension.js` in an isolated Extension Development Host, opens the assembled panel against a deterministic local server, verifies that an already-open editor is injected, answers a native approval, restarts the server, and compares the user-visible outcome snapshot.

## Known Limitations and Deferred Work

- **Context injection targets a heuristic session** — the active session is tracked host-side (last running, else first seen); when several sessions are attached, injection may target a different one than the panel is showing until a webview→host active-session signal exists.
- **Native approval prompts coexist with the in-panel ones** — both surfaces show every approval/question; v1 does not suppress either. A per-window toggle is deferred to when the extension grows a settings surface.
- **One panel per window** — the extension hosts a single GUI panel; multiple simultaneous panels are not supported.
