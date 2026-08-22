# dsh-web-launcher

English | [中文](README.zh.md)

Shared `dsh web` launcher primitives for shell hosts. The desktop shell (`@deepseek-ai/dsh-desktop`) consumes this package; the VS Code extension host is the intended next consumer. It is pure Node logic — no Electron or VS Code imports — so consumers own spawning, window glue, and teardown.

## Surface

```ts
import { resolveWebLaunch, waitForReadyLine, waitForHttpOk, childExited, WEB_ARGS } from '@deepseek-ai/dsh-web-launcher'

declare const appDir: string
declare const stdout: AsyncIterable<string>

// 1. Decide how to launch `dsh web` (DSH_BIN → embedded closure → checkout → PATH).
const launch = resolveWebLaunch({ env: process.env, appDir, execPath: process.execPath })
// 2. After spawning, wait for `dsh web: http://127.0.0.1:<port>` on stdout.
const url = await waitForReadyLine(stdout)
// 3. Poll the advertised URL until it answers HTTP 200.
await waitForHttpOk(url)
```

`resolveWebLaunch` resolves in a fixed order: `DSH_BIN` env; the embedded deploy closure at `<appDir>/deploy/node_modules/@deepseek-ai/dsh/lib/bin.js` run under Electron-as-Node (`ELECTRON_RUN_AS_NODE=1` with `--expose-internals`, because the harness's HMR service needs Node internals and the `node-addon-require-builtin` fallback does not work under Electron's V8); the surrounding checkout's CLI (`<appDir>/../../apps/cli`, built `lib/bin.js` else the tsx source launch); `dsh` on PATH. On Windows an unset or empty `DSH_PERMISSION_MODE` falls back to `danger-full-access` because the harness has no confinement backend there. `waitForReadyLine` reassembles chunk-split lines, requires an explicit port (a split fragment can never match), and keeps draining the stream after readiness so the live server never dies with EPIPE; an `onChunk` exception is reported to stderr without stopping that drain. `waitForHttpOk` bounds each attempt and the following sleep by the remaining overall deadline.

## Model Experience

None, as this is a pure launch-resolution primitive; nothing here reaches a model request.

#### KV Cache effect

None; nothing here enters a request prefix.

## Known Limitations and Deferred Work

- **The readiness contract is the `dsh web: ` stdout prefix** — a change to the server's readiness line must update `parseReadyLine` in the same PR; nothing else pins the two together.
- **Checkout discovery assumes the `apps/<name>` layout** — the repository root is derived as `<appDir>/../..`; a consumer outside that layout simply misses the checkout candidates and falls through to PATH.
