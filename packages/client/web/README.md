# @deepseek-ai/dsh-client-web

English | [中文](README.zh.md)

Web shell kernel: `new AppWebEntry(el, options?).run()` mounts the whole client through the two-stage boot (web2). Stage one (module face): build the client module system (`@deepseek-ai/dsh-client-modules`) over the host-pushed entry graph (`window.__DSH_BOOT__`) and prefetch the `immediately` tier in parallel — bundle execution registers factories only. Stage two (plugin face): mount the vendored cordis Loader with the module system injected as its `internal` seam, create one loader entry per graph row plus the shell-own app-shell assembly entry (tree.import materializes each module), and gate AppRoot on the settle (loader quiesced + every entry fiber ACTIVE → full UI in one switch). Composition is entirely the host graph's: the roster and the immediately tier live in the composing app; the shell makes zero composition decisions.

Shell self-sufficiency (web2 hard rule): the kernel value-imports no graph plugin package — the boot status store and signals are hand-rolled here (`loader-status.ts`), so the loading page works while (and especially when) plugins fail. The kernel statically registers its app-shell assembly (`@deepseek-ai/dsh-client-app-shell`, a pseudo entry with no npm package behind it) and the modules enrollment entry; both still activate through Loader fibers.

`PLATFORM_MODULES` (src/platform.ts) is the single source of truth for the shared module surface: seed-table keys, tsdown client externals, and the vite alias set are its projections.

The optional `BootOptions` parameter carries `fetchBundle`/`executeBundle` transport overrides (`BootSeams`) and an embedder's `staticPlugins` table. Transport overrides serve test environments where `<script>` execution cannot reach the page context (jsdom). Static plugin keys must name boot-manifest rows and cannot replace the kernel-owned entries; valid rows follow the ordinary Loader activation path while prefetch and import bypass bundle fetch and execution.

The shell owns browser-title projection. With a selected session carrying a durable title, it renders `<session title> — <existing HTML title>` and reacts to later title revisions; no selection or a selected untitled session preserves the existing title, and shell unmount restores it. The existing HTML title remains the configurable product suffix.

## Model Experience

None, as the entry shell boots the browser plugin tree; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **One-shot rendering by design** — the UI waits for the boot settle; a single entry failure keeps the loading page with a loud per-entry report, no partial availability (progressive rendering returns with its own project).
- **Narrow-window acceptance is deferred** — the concession chain is implemented in ui-layout but the shell-level narrow-viewport walkthrough is a P-II acceptance item.
