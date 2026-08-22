# `dsh-vscode`

English | [中文](README.zh.md)

VS Code extension hosting the DeepSeek Harness GUI in the **Secondary Side Bar**. It spawns one managed `dsh web` per window, hosts the complete dsh client stack in a webview view, and bridges the webview's `/api` traffic to the server through the extension host. Unlike the lightweight chat-participant integration, it keeps the rich GUI intact: Plan Mode, the trajectory view, slot-based tool cards, and the settings pages.

## The sidebar shell

The GUI's wide shell lays its three slots out as resizable columns and refuses to go below a 640px center with a 280px sidebar that never concedes — geometry a 300-400px editor sidebar cannot satisfy. So this webview loads its own shell (`webview/shell/`) in place of [`ui-layout`](../../packages/client/ui-layout/README.md).

The substitution costs no plugin any change. `root` takes a single occupant, so exactly one shell may load, and this one declares **the same three child slots** (`sidebar`, `conversation`, `details`) with identical kinds and scopes; `ui-sidebar`, `ui-conversation` and every registrant beneath them compose unchanged. What differs is the arrangement: the panes are stacked routes rather than columns, and one is in front at a time. All three stay mounted regardless of route — unmounting would discard scroll position, the composer draft, and a streaming turn's live subscriptions — with CSS selecting the front one.

`ctx.layout` is implemented verbatim from the wide shell's `ILayout`, so cross-plugin panel gestures keep working with only their meaning changed: toggling the sidebar routes between the sessions pane and the conversation, and opening details brings that pane forward.

Navigation lives in **native view title actions**, not webview pixels — the scarcest resource in a narrow column. The host retains the latest requested route until the webview reports that its page-level listener is ready; the webview then replays that route through `webview/route-bridge.ts`, and `NarrowLayoutService` retains it again until the root store attaches. A title action therefore survives initial page and plugin boot instead of becoming a one-shot message.

The shell lives in this app rather than `packages/client` because the VS Code sidebar is its only consumer; a second narrow-container host is what would justify promoting it to a package.

### Fitting the occupants

The occupants were drawn for a 736-800px column, so the frame also carries a compact scale. Two mechanisms, chosen by what the component measures itself against:

- **Host variables** for anything sized by its container — the composer's side clearance, card cap, dock inset, toolbar gaps and model-name cap, the hero's clearance and its wider-than-the-card glow. Each is a `-host` default on the component that reads it (`var(--dsh-…-host, desktop)`), overridden once on the frame, so the wide shell keeps its rhythm. The composer toolbar additionally gets permission to wrap: its controls are fixed-size, so past a point only a second line fits them.
- **Media queries** for anything anchored to the viewport — the settings modal (its 188px nav rail becomes a horizontal strip above the content, and the appearance cubes go from three stacked rows to one), and the settings rows' 48px text inset. A webview is its own iframe, so `100vw` and media queries see the sidebar's width; in the browser shell the same rules only fire if the window itself is that narrow, which is correct.

## How it fits together

```text
webview (browser)            extension host (Node)             dsh web
  PostMessageApiClient  ──▶   ApiBridge  ──▶  loopback fetch  ──▶  /api
  full dsh client stack  ◀──  postMessage  ◀──  SSE/JSON  ◀──────  /api
```

The webview's page origin is `vscode-webview://…`, which the server's `/api` browser-trust fence refuses. So the webview never fetches the server directly: its transport (`PostMessageApiClient` from [`@deepseek-ai/dsh-client-connection`](../../packages/client/connection/README.md)) posts requests to the extension host, which replays them against the server's loopback origin — a loopback Host passes the fence like any non-browser client. The extension host retains server readiness until the page listener is installed, so the bootstrap does not misclassify an ordinary startup interval as incompatibility. After that signal, the bootstrap sends only `host.describe` before publishing the transport to the plugin graph and requires the host's `protocolVersion` to equal the bundled client's; an older, newer, missing, or malformed version renders an incompatible-host state and starts neither the client plugins nor their streams. The bridge confines every relayed request to that origin under `/api/`: an absolute URL, a protocol-relative or backslash authority, or a non-API path is refused before any fetch, so injected webview script cannot borrow the host's loopback network reach for other targets. The compatible GUI is the ordinary dsh client stack, bundled statically by `webview/vite.config.ts` (the webview's CSP forbids fetching plugin bundles, so every plugin ships inside one bundle) and booted through the shared `AppWebEntry` kernel with the roster registered as static plugins.

The extension launches, on demand:

```sh
dsh web --host 127.0.0.1 --port 0
```

through the shared [`@deepseek-ai/dsh-web-launcher`](../../packages/util/web-launcher/README.md) primitive (the desktop shell uses the same one), which resolves `dsh` in the order `DSH_BIN` → embedded closure → checkout → PATH. `--port 0` means parallel windows never collide. One serialized lifecycle transaction owns start, restart, and deactivation: it detaches a runtime before awaiting disposal, cleans failed starts, and closes publication synchronously when teardown begins, so concurrent restarts cannot orphan a server and a restart racing deactivation cannot launch one afterward.

## Native interactions

Beside the webview, the extension host opens its own mux stream (a plain loopback wire client — the extension host is not a browser, so it passes the `/api` trust fence directly) and surfaces the agent's **approval** and **question** requests as editor-native prompts: a notification with Allow/Reject for approvals, a QuickPick or input box for questions. This native layer starts only after the same `protocolVersion` check; an incompatible external `dsh` leaves both GUI boot and native integration disabled with a visible explanation. An approval prompt is enriched with what the call will do, taken from a `tool/call` view cached per session. Because the wire is multi-client, this runs alongside the webview's in-panel prompts: whichever surface answers first wins, and the other's late answer is a harmless no-op. When a question resolves elsewhere its QuickPick/input box closes itself; an approval notification cannot be closed programmatically (VS Code limitation) — it is non-modal and simply superseded.

## Editor context injection

The extension feeds the model your editor context so a prompt can refer to "this file" without pasting. On editor changes (active file, selection, diagnostics) a debounced sampler builds a bounded reading — the active file and range, the selection or a cursor window, and error/warning diagnostics — and injects it into the active session over `session.injectContext`, the no-wakeup wire method (it stages for the session's next step and never starts a turn on its own). A reading whose signature matches the last one sent is suppressed, so idle cursor jitter injects nothing. The target session is tracked from the host stream (the most recently running session, else the first one seen); precise "the session the user is viewing" selection awaits a webview→host signal.

## Commands

- **DeepSeek Harness: Focus Sidebar** — reveal the view (VS Code resolves it on first reveal, which starts the server).
- **DeepSeek Harness: Show Conversation** / **Show Sessions** — route the front pane; both are title actions on the view, and their latest request is replayed after webview readiness.
- **DeepSeek Harness: Restart Server** — serialize tree-kill and relaunch of the managed server. The view stays: the bridge resolves the server origin through a live getter, so the webview reconnects to the new port by itself.

## Windows

Windows has no harness confinement backend, so the CLI's default `workspace-write` permission mode cannot boot there. When `DSH_PERMISSION_MODE` is unset the launcher falls back to `danger-full-access` (approval prompts disabled) and logs a warning; set `DSH_PERMISSION_MODE` explicitly to override. This is the same fallback the desktop shell applies.

## Build

```sh
pnpm --filter dsh-vscode run build       # host bundle (tsdown) + webview bundle (vite)
pnpm --filter dsh-vscode run build:host  # extension host only
pnpm --filter dsh-vscode run build:webview
```

The host build emits one self-contained `dist/extension.js` (workspace runtime imports inlined; only the VS Code API stays external). The webview build emits `dist/webview/webview.js` + `webview.css`, served through `asWebviewUri`.

## Package (self-contained vsix)

```sh
pnpm --filter dsh-vscode run package    # packs a vsix for the host platform
```

`package` runs the full repo build, materializes `deploy/` (the `dsh-vscode-closure` dependency-only deploy root — the same self-contained `dsh web` bundle the desktop shell ships), builds the extension, and runs `vsce package --no-dependencies` for one platform target through [scripts/package-vsix.mjs](scripts/package-vsix.mjs). The target defaults to the host platform; set `DSH_VSIX_TARGET` (e.g. `linux-x64`, `darwin-arm64`) in the environment to override — a Node script reads it, so this works identically on every OS without POSIX shell syntax. The vsix carries the runtime under `dist/`, `deploy/`, and `media/`, plus the extension manifest, readmes, and license retained by [.vscodeignore](.vscodeignore); no source or development `node_modules` tree ships.

The packaged extension needs no Node, no `dsh`, and no checkout: the launcher's embedded-closure branch runs the bundled CLI under **VS Code's own Electron as Node** (`ELECTRON_RUN_AS_NODE=1` with `--expose-internals`, exactly the desktop shell's mechanism, with `process.execPath` being the extension host's Electron). The closure's native addons (node-pty, koffi) are N-API and need no rebuild.

Because the closure carries platform-native addons, the vsix is **per-platform** (`vsce package --target <target>`); a CI matrix packs one per `win32-x64`, `linux-x64`, `darwin-x64`, `darwin-arm64`, etc. A dev checkout without `deploy/` falls through to the checkout's built CLI or `dsh` on PATH, so `pnpm --filter dsh-vscode run build` + an Extension Development Host works without packaging.

## Tests

`tests/` covers the pure extension-host logic keyless over injected clients, UI, spawn, and schedulers: the process runtime (`runtime.spec.ts`), serialized ownership across concurrent restart/deactivation (`runtime-lifecycle.spec.ts`), the postMessage↔fetch relay and its SSRF confinement (`bridge.spec.ts`), server-ready gating plus pre-boot protocol rejection for older/newer/missing versions (`webview-bootstrap.spec.ts`), ready/replay routing (`view-route.spec.ts`, `route-bridge.spec.ts`, `shell.spec.tsx`), the view HTML/CSP (`panel.spec.ts`), the static roster's parity with the shipped web config (`roster.spec.ts`), native interactions, active-session tracking, IDE-context sampling, and the serialized context feed. The browser lane (`pnpm run test:web`, config `vitest.web.config.ts`) serves the built `dist/webview` through the real `panelHtml()` document with the shipped CSP: `webview-boot.e2e.ts` fails unless React mounts without an uncaught error, while `sidebar.snapshot.ts` boots the keyless fixture at 259px and records the sessions route, question and approval composers, representative tool rows, and horizontal containment through the same stable-ARIA/golden helper as the Web application lane. Browser-launch failure closes the already-listening test server before propagating. That lane needs the webview bundle built first (`pnpm --filter dsh-vscode run build:webview`) and a Playwright browser; set `DSH_CHROMIUM_PATH` to reuse a Chromium already on the machine when the Playwright CDN is unreachable. Booting the view inside a real editor is still a manual step: there is no `@vscode/test-electron` lane in the repo today.

## Known Limitations and Deferred Work

- **Native diff-editor and jump-to-location have foundations but no trigger yet** — [`src/locations.ts`](src/locations.ts) resolves a tool view's model-facing paths into absolute editor targets and extracts consistent two-pane diff materials from the wire (an edit compares the hunk fragments both sides carried; a create compares an empty left against the whole new file — it does **not** mix a disk whole-file left pane with a hunk right pane). Opening a native `vscode.diff` or revealing a location needs a client-side "open in editor" signal from a tool card, which is a client-plugin change deferred to a dedicated UI phase; a true whole-file view (applying the hunk to disk) lands with that trigger.
- **Context injection targets a heuristic session** — the active session is tracked host-side (last running, else first seen); when several sessions are attached, injection may target a different one than the panel is showing until a webview→host active-session signal exists.
- **Native approval prompts coexist with the in-panel ones** — both surfaces show every approval/question; v1 does not suppress either. A per-window toggle is deferred to when the extension grows a settings surface.
- **Self-contained packaging assumes VS Code's Node is in the harness engine range** — the embedded closure runs under VS Code's Electron-as-Node, which must satisfy the harness `node ^22.19 || >=24` range. A VS Code build shipping an out-of-range Node needs a PATH-based vsix (no `deploy/`, relying on an installed `dsh`) instead; confirming the range for the targeted VS Code versions is a release gate.
- **The vsix is signed/published separately** — `package` produces an unsigned vsix per platform; marketplace signing and publish (`vsce publish`) are a release step, and `keytar`/`vsce-sign` native builds are denied for local packaging.
- **One view per window** — the extension hosts a single sidebar view; multiple simultaneous GUI surfaces are not supported.
- **A live-provider editor transcript remains manual** — the assembled browser snapshot proves the built webview renders fixture assistant content, interaction composers, and tool rows at 259px without root-level horizontal scrolling or uncontained overflow. A Markdown table retains one intentional content-level horizontal scroller. A real provider turn inside an Extension Development Host remains manual until an editor-host lane exists.
