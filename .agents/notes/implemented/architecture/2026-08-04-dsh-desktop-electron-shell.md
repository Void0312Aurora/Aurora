# Agent Note: dsh-desktop — the Electron shell for the Web GUI

Status: implemented

English | [中文](2026-08-04-dsh-desktop-electron-shell.zh.md)

> Scope: a new product assembly `apps/desktop` (`@deepseek-ai/dsh-desktop`) that hosts the existing `dsh web` GUI in a standalone Electron window with tray residency, plus its self-contained packaging story (electron-builder + a `dsh-desktop-closure` deploy root materialized with `pnpm deploy` and run under Electron-as-Node).

## Problem

The Web GUI is the product's richest interaction surface but lives inside a browser tab: no taskbar presence, no tray, no dedicated window chrome, and every launch means opening a terminal, starting `dsh web`, and keeping the tab alive. Users asked for a standalone window. The GUI is inherently client–server — `dsh web` serves a local HTTP API and static shell at `127.0.0.1:<port>` — so a "desktop app" cannot be a single process; it must be a client shell that owns the server's lifecycle. The shell therefore had to solve: where `dsh web` comes from (checkout, PATH, or bundled), how to learn the port without configuration (the server supports `--port 0`, OS-assigned), how to detect readiness (`dsh web` prints `dsh web: http://127.0.0.1:<port>` only after listening), and how the window's life relates to the server's (tray residency: close ≠ quit).

## Decision

**`apps/desktop` is a thin Electron main that spawns `dsh web` and manages its lifecycle; all decision logic is Electron-free and unit-tested.** `src/launcher.ts` resolves the server command in a fixed order — `DSH_BIN` env, the embedded closure (`deploy/node_modules/@deepseek-ai/dsh/lib/bin.js`), this checkout's CLI (built `lib/bin.js`, else the tsx source launch), `dsh` on PATH — spawns with `web --host 127.0.0.1 --port 0`, buffers stdout into lines, parses the readiness line (requiring an explicit port, so a chunk-split partial line can never match), and polls HTTP 200 with a short per-attempt abort. `src/main.ts` is the Electron glue only: single-instance lock, window (sandboxed renderer, no preload), tray, and child lifecycle. On Windows `child.kill()` is `TerminateProcess`, so the server gets no graceful-dispose signal on quit; session JSONL is written per event, so nothing already logged is lost — this is documented rather than engineered around.

**Tray residency, not window lifetime.** Closing the window hides it and keeps the server running; the tray menu reopens the window or quits (killing the server). A second launch focuses the existing window. The packaged app never needs Node, `dsh`, or a checkout: the embedded closure runs under Electron-as-Node (`ELECTRON_RUN_AS_NODE=1`), and its native addons (node-pty, koffi) are N-API, so no rebuild against Electron headers (`npmRebuild: false`).

**Packaging reuses the repo's proven deploy pattern.** `apps/desktop/closure` is a dependency-only deploy root (`@deepseek-ai/dsh` + `@deepseek-ai/dsh-frontend`), materialized by `pnpm deploy` into `apps/desktop/deploy` exactly like `python/sdk-runtime`; `apps/web` gained a `files: ["dist"]` field so its built GUI lands in the closure. electron-builder packs `lib/`, `build/` (icons), and `deploy/`; this package itself has zero runtime dependencies, so electron-builder's own node_modules handling never touches the closure. `dist` first runs the full repo build (`build:lib` + `build:web`) because the closure copies built artifacts, not sources.

## Alternatives considered

- **PWA "install as app"** — zero new dependencies and works today, but the window is still the browser, there is no tray, and the install surface varies by browser; the user explicitly chose a real desktop shell.
- **Tauri** — lighter than Electron, but requires a Rust toolchain the user does not have; Electron is pure Node/pnpm, which this repo already is.
- **Fixing port 3080 and parsing the URL** — rejected: `--port 0` plus the readiness line is configuration-free and can never collide with an existing `dsh web` (browser and desktop instances can run side by side).
- **Bundling the whole harness with `@yao-pkg/pkg --sea`** (the Python SDK route) — the SEA pipeline is linux/macos-only today and embedding web dist assets would need new pkg asset plumbing; Electron-as-Node over a `pnpm deploy` closure achieves the same self-containment with zero new build infrastructure.
- **`child.kill()` on Windows is abrupt** — a stdin command channel or `GenerateConsoleCtrlEvent` could give the server a graceful-dispose path; deferred as unneeded for v1 because JSONL is event-durable.

## Consequences

`pnpm --filter @deepseek-ai/dsh-desktop dev` opens the GUI in a standalone window from the checkout; `dist` produces an NSIS installer and a portable exe that run without any preinstalled tooling. The launcher is keyless-unit-tested (`apps/desktop/tests/launcher.spec.ts`); the Electron glue is deliberately too thin to snapshot. The server's stdout is forwarded with a `[dsh web]` prefix; the packaged app logs nowhere else. Known v1 warts, documented in the README: the harness-source prompt section names a nonexistent checkout path inside the packaged app (cosmetic; nothing reads it at boot), the invoking-directory workspace semantics make a Start-menu launch start in the shell's cwd, tray-icon theming is a single inverted PNG, and external links always leave the app via the system browser.
