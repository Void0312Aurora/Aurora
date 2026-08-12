# Agent Note: dsh-vscode self-contained packaging

Status: implemented

English | [中文](2026-08-12-vscode-self-contained-packaging.zh.md)

> Scope: the packaging story for `apps/vscode` — a per-platform vsix that carries the whole `dsh web` server as a materialized closure and runs it under VS Code's own Electron-as-Node, so the extension needs no preinstalled Node, `dsh`, or checkout. Reuses the desktop shell's closure mechanism ([desktop note](2026-08-04-dsh-desktop-electron-shell.md)).

## Problem

The extension is useless without a `dsh web` server, and requiring users to install the harness separately defeats a one-click marketplace install. The desktop shell already solved "ship the whole server as a self-contained bundle and run it under Electron-as-Node"; the vsix needs the same, adapted to VS Code's packaging (`vsce`) and its extension host as the Electron-as-Node runtime.

## Decision

**The vsix ships a materialized `dsh web` closure, not a dependency tree.** `apps/vscode/closure/package.json` (`dsh-vscode-closure`) is a dependency-only deploy root whose manifest mirrors `apps/desktop/closure` — the harness closure plus the web-only seam packages, the CLI app, and the web frontend. `pnpm run deploy:closure` runs `pnpm deploy` into `apps/vscode/deploy/`, the self-contained server the packaged extension runs. The `.vscodeignore` ships only `dist/`, `deploy/`, and `media/`; no `node_modules`.

**The extension host is the Electron-as-Node runtime — no new mechanism.** The launcher's embedded-closure branch already spawns `<appDir>/deploy/node_modules/@deepseek-ai/dsh/lib/bin.js` under `process.execPath` with `ELECTRON_RUN_AS_NODE=1` and `--expose-internals`. In the extension `process.execPath` is VS Code's Electron and `appDir` is the extension root, so a packed vsix with `deploy/` present takes that branch with no code change; the shared `@deepseek-ai/dsh-web-launcher` already carries and tests this resolution. A dev checkout without `deploy/` falls through to the checkout CLI or PATH, so the Extension Development Host works unpackaged.

**Unlike the desktop shell, the extension host bundle needs no materialize/fixup.** The desktop main is compiled with `tsc` and had to copy its workspace primitives into `lib/` and rewrite the specifiers; the extension host is a `tsdown` bundle that already inlines `dsh-process-tree` and `dsh-web-launcher` into a self-contained `dist/extension.js`. Only the server closure is materialized.

**The vsix is per-platform.** The closure carries N-API native addons (node-pty, koffi), so `vsce package --target <target>` produces one vsix per platform — the target comes from `DSH_VSIX_TARGET` through `scripts/package-vsix.mjs` (a Node script, so the default expands identically on every OS), defaulting to the host platform; packing the full set per release belongs to the CI/release pipeline, which does not exist yet. Native addons are ABI-compatible with Electron-as-Node, so no rebuild.

## Alternatives considered

- **Require a preinstalled `dsh`** — a thin JS-only vsix relying on PATH; simplest, but a marketplace user expects install-and-go. Kept as the documented fallback for VS Code builds whose Node is out of range.
- **Bundle Node in the vsix** — redundant: the extension host is already an Electron that runs as Node, exactly as the desktop shell exploits.
- **A single universal vsix** — impossible with native addons; the platform target is mandatory.
- **Reuse `apps/desktop/closure` directly** — `pnpm deploy` targets one package into its own deploy dir; a parallel closure package is the same pattern each self-contained assembly follows (the desktop and the Python runtime each own one).

## Consequences

`DSH_VSIX_TARGET=<target> pnpm --filter dsh-vscode run package` produces a self-contained per-platform vsix (the workspace member is `dsh-vscode`, unscoped so `vsce` accepts the extension `name`). The closure resolves as a workspace member (`apps/vscode/closure`, ignored by knip like the desktop closure) and `deploy/` is gitignored. The one release gate this design carries: the embedded closure runs under VS Code's Electron-as-Node, which must satisfy the harness `node ^22.19 || >=24` engine range — a VS Code build shipping an older Node needs the PATH-based fallback vsix instead, and confirming the range for the targeted VS Code versions is a packaging-time check, not something a unit test can assert. Marketplace signing/publish is a separate release step; `keytar` and `@vscode/vsce-sign` native builds are denied in `pnpm-workspace.yaml` because `vsce package --no-dependencies` needs neither. The actual `vsce package` run and the per-platform matrix live in CI/release, like the desktop `dist` pipeline — the repo carries the configuration and the closure manifest, verified by the closure resolving and the launcher's own tested resolution order.
