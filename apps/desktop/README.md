# `@deepseek-ai/dsh-desktop`

English | [中文](README.zh.md)


Electron shell for the DeepSeek Harness Web GUI: it spawns `dsh web`, waits for the server's readiness line, and hosts the GUI in a standalone window. Closing the window hides it and keeps the server running in the tray; the tray menu reopens the window or quits the app (and with it the server). One instance per machine — a second launch focuses the existing window instead of starting a second server.

## Running from the checkout

Build the repo first — `pnpm run build` produces the CLI lib, the web dist, and this package's lib (the `build:lib` step compiles the tree-kill and web-launcher primitives into `lib/process-tree/` and `lib/web-launcher/` automatically). `deploy:closure` is needed only to run the embedded closure instead of the checkout branches (see below):

```sh
pnpm run deploy:closure
pnpm --filter @deepseek-ai/dsh-desktop dev
```

The launcher (the shared [`@deepseek-ai/dsh-web-launcher`](../../packages/util/web-launcher/README.md) primitive) resolves `dsh web` in this order:

1. `DSH_BIN` — an explicit executable path (useful for a custom CLI build);
2. the embedded closure at `deploy/node_modules/@deepseek-ai/dsh/lib/bin.js` (whenever `deploy/` is materialized — always in packaged builds, and in a dev checkout after `deploy:closure`; see Packaging);
3. this checkout's CLI — built `apps/cli/lib/bin.js` when present, else the tsx source launch (`node --import tsx/esm apps/cli/src/bin.ts`) the root `pnpm run dsh` script uses;
4. `dsh` on `PATH`.

The server always listens on `127.0.0.1` on an OS-assigned port (`--port 0`), so it can never collide with an existing `dsh web`; the readiness line `dsh web: http://127.0.0.1:<port>` is parsed from stdout, then polled for HTTP 200. Loopback requests pass the /api browser-trust fence by default, so no extra flags are needed. If `deploy/` is materialized (you ran `deploy:closure` or `dist`), the embedded closure shadows the checkout branches — re-run `deploy:closure` after CLI changes, or set `DSH_BIN` to force a specific launch.

## Behavior notes

- The window is a plain sandboxed renderer (`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`) with no preload: the GUI is a normal web application. Links that would open a new window or navigate off the server origin go to the system browser instead.
- Closing the window does not quit — the server keeps running and the tray icon stays. **Quit** terminates the `dsh web` process tree and exits. On Windows the tree kill is `taskkill /T` because `child.kill()` is `TerminateProcess` of the direct child only, and the server does not run its graceful-dispose path; session data is written per event to JSONL, so a killed server loses nothing already logged.
- Windows has no harness confinement backend, so the CLI's default `workspace-write` permission mode cannot boot there. When `DSH_PERMISSION_MODE` is unset the shell falls back to `danger-full-access` (approval prompts are disabled) and logs a warning; set `DSH_PERMISSION_MODE` explicitly to override.
- If the Electron main is hard-killed (Task Manager, a crash), a small reaper child polls it and tree-kills the server within a second, so `dsh web` never outlives its window.
- The server's stdout is forwarded to this process's stdout with a `[dsh web]` prefix; run `electron .` from a terminal to see both streams. The packaged app writes nothing to disk besides Electron's own `userData` and the harness's normal `$DSH_HOME`/workspace files.
- Session and workspace semantics are the CLI's: the invoking directory is the default project/Workspace root, and `$DSH_HOME/config.yaml` applies as usual. Launching the packaged app from a Start-menu shortcut starts with the shell's cwd, so prefer opening the app from a project directory or picking the Workspace in the GUI.

## Packaging

```sh
pnpm --filter @deepseek-ai/dsh-desktop dist        # NSIS installer + portable exe under release/
pnpm --filter @deepseek-ai/dsh-desktop dist:dir    # unpacked dir only, for a quick smoke
```


`dist` first builds the repo (`build:lib` + `build:web`), then materializes the self-contained web closure with `pnpm run deploy:closure` (the `dsh-desktop-closure` deploy root, the same pattern `python/sdk-runtime` uses), then runs electron-builder with `electron-builder.yml`. The installers and executables are unsigned, so Windows SmartScreen may warn on first run. The packaged app needs no Node, no `dsh`, and no checkout: the launcher's embedded-closure branch runs the bundled CLI under Electron-as-Node (`ELECTRON_RUN_AS_NODE=1`) with `--expose-internals` — the harness's HMR service needs Node internals, and the `node-addon-require-builtin` fallback does not work under Electron's V8. The closure's native addons are N-API and need no rebuild against Electron; `deploy/**` and `lib/types/reaper.js` are unpacked from the asar so the run-as-Node children can read them.

Icons (`build/icon.png`, `build/tray-icon.png`) are rasterized from `apps/web/public/favicon.svg` by `pnpm run icons` and committed; regenerate them if the favicon changes.

## Tests

The pure launcher logic — command resolution, readiness-line parsing, and the readiness polls — lives in [`@deepseek-ai/dsh-web-launcher`](../../packages/util/web-launcher/README.md) with its own keyless suite; this package's tests cover the built-entry import graph and the assembled Electron lifecycle.
