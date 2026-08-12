# `@deepseek-ai/dsh-vscode`

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

Beside the webview, the extension host opens its own mux stream (a plain loopback wire client — the extension host is not a browser, so it passes the `/api` trust fence directly) and surfaces the agent's **approval** and **question** requests as editor-native prompts: a notification with Allow/Reject for approvals, a QuickPick or input box for questions. An approval prompt is enriched with what the call will do, taken from a cached `tool/call` view. Because the wire is multi-client, this runs alongside the webview's in-panel prompts: whichever surface answers first wins, and the other's late answer is a harmless no-op. A prompt still open when the request resolves elsewhere closes itself.

## Editor context injection

The extension feeds the model your editor context so a prompt can refer to "this file" without pasting. On editor changes (active file, selection, diagnostics) a debounced sampler builds a bounded reading — the active file and range, the selection or a cursor window, and error/warning diagnostics — and injects it into the active session over `session.injectContext`, the no-wakeup wire method (it stages for the session's next step and never starts a turn on its own). A reading whose signature matches the last one sent is suppressed, so idle cursor jitter injects nothing. The target session is tracked from the host stream (the most recently running session, else the first one seen); precise "the session the user is viewing" selection awaits a webview→host signal.

## Commands

- **DeepSeek Harness: Open Panel** — start the server (if needed) and reveal the GUI panel beside the editor.
- **DeepSeek Harness: Restart Server** — tree-kill and relaunch the managed server, then reopen the panel.

## Windows

Windows has no harness confinement backend, so the CLI's default `workspace-write` permission mode cannot boot there. When `DSH_PERMISSION_MODE` is unset the launcher falls back to `danger-full-access` (approval prompts disabled) and logs a warning; set `DSH_PERMISSION_MODE` explicitly to override. This is the same fallback the desktop shell applies.

## Build

```sh
pnpm --filter @deepseek-ai/dsh-vscode run build       # host bundle (tsdown) + webview bundle (vite)
pnpm --filter @deepseek-ai/dsh-vscode run build:host  # extension host only
pnpm --filter @deepseek-ai/dsh-vscode run build:webview
```

The host build emits one self-contained `dist/extension.js` (workspace runtime imports inlined; only the VS Code API stays external). The webview build emits `dist/webview/webview.js` + `webview.css`, served through `asWebviewUri`.

## Package (self-contained vsix)

```sh
pnpm --filter @deepseek-ai/dsh-vscode run deploy:closure   # materialize the dsh web server closure into deploy/
DSH_VSIX_TARGET=win32-x64 pnpm --filter @deepseek-ai/dsh-vscode run package
```

`package` runs the full repo build, materializes `deploy/` (the `dsh-vscode-closure` dependency-only deploy root — the same self-contained `dsh web` bundle the desktop shell ships), builds the extension, and runs `vsce package --no-dependencies` for one platform target. The vsix carries `dist/`, `deploy/`, and `media/` only (see [.vscodeignore](.vscodeignore)); no `node_modules`.

The packaged extension needs no Node, no `dsh`, and no checkout: the launcher's embedded-closure branch runs the bundled CLI under **VS Code's own Electron as Node** (`ELECTRON_RUN_AS_NODE=1` with `--expose-internals`, exactly the desktop shell's mechanism, with `process.execPath` being the extension host's Electron). The closure's native addons (node-pty, koffi) are N-API and need no rebuild.

Because the closure carries platform-native addons, the vsix is **per-platform** (`vsce package --target <target>`); a CI matrix packs one per `win32-x64`, `linux-x64`, `darwin-x64`, `darwin-arm64`, etc. A dev checkout without `deploy/` falls through to the checkout's built CLI or `dsh` on PATH, so `pnpm --filter @deepseek-ai/dsh-vscode run build` + an Extension Development Host works without packaging.

## Tests

`tests/` covers the pure extension-host logic keyless: the launch/readiness/teardown lifecycle over an injected spawn (`runtime.spec.ts`), the postMessage↔fetch relay (`bridge.spec.ts`), the panel HTML/CSP (`panel.spec.ts`), and the static roster's parity with the shipped web config (`roster.spec.ts`). The webview boot and the assembled panel are exercised end-to-end by the extension's own `@vscode/test-electron` lane (landing with the editor-integration phases).

## Known Limitations and Deferred Work

- **Native diff-editor and jump-to-location have foundations but no trigger yet** — [`src/locations.ts`](src/locations.ts) resolves a tool view's model-facing paths into absolute editor targets and reconstructs whole-file diff panes (reading disk for an edit's left pane), but opening a native `vscode.diff` or revealing a location needs a client-side "open in editor" signal from a tool card, which is a client-plugin change deferred to a dedicated UI phase.
- **Context injection targets a heuristic session** — the active session is tracked host-side (last running, else first seen); when several sessions are attached, injection may target a different one than the panel is showing until a webview→host active-session signal exists.
- **Native approval prompts coexist with the in-panel ones** — both surfaces show every approval/question; v1 does not suppress either. A per-window toggle is deferred to when the extension grows a settings surface.
- **Self-contained packaging assumes VS Code's Node is in the harness engine range** — the embedded closure runs under VS Code's Electron-as-Node, which must satisfy the harness `node ^22.19 || >=24` range. A VS Code build shipping an out-of-range Node needs a PATH-based vsix (no `deploy/`, relying on an installed `dsh`) instead; confirming the range for the targeted VS Code versions is a release gate.
- **The vsix is signed/published separately** — `package` produces an unsigned vsix per platform; marketplace signing and publish (`vsce publish`) are a release step, and `keytar`/`vsce-sign` native builds are denied for local packaging.
- **One panel per window** — the extension hosts a single GUI panel; multiple simultaneous panels are not supported.
