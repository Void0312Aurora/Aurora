# Agent Note: the VS Code sidebar shell — replacing the root occupant instead of the plugins

Status: implemented

English | [中文](2026-08-14-vscode-sidebar-shell.zh.md)

> Scope: moving `apps/vscode` from a webview panel in an editor column to a webview view in the Secondary Side Bar, and the shell substitution that makes the existing GUI composable at 300-400px without touching a single downstream plugin. Builds on the [rich-UI extension](2026-08-12-vscode-rich-ui-extension.md), which owns the panel/server/bridge foundation.

## Problem

Hosting the full web GUI in an editor tab was the fastest way to get the rich surface into VS Code, and it was the wrong shape twice over. It takes an entire editor column, which fights the "ask a question about the file I am reading" workflow the integration exists for. And the GUI it hosts is a three-column desktop layout: [columns.ts](../../../../packages/client/ui-layout/src/client/columns.ts) fixes `CENTER_MIN` at 640px and `SIDEBAR_MIN` at 280px with the comment that the sidebar never concedes, and no breakpoint collapses it. In a 300px sidebar the conversation column would be squeezed to nothing.

The obvious reading of "redo the UI for a sidebar" is a rewrite of the presentation layer — the client AGENTS.md even licenses it, calling components consumables "expected to be rewritten wholesale". Twenty client plugin packages is a large bill for a layout problem.

## Decision

**Replace the occupant of `root`, not the plugins beneath it.** `SlotsService` declares `root` as a single-occupant slot at construction, so a second registration fails loud at load; that mutual exclusion is exactly the seam a second shell needs. `apps/vscode/webview/shell/` registers a single-pane frame into `root` and declares **the same three child slots** the wide shell declares — `sidebar`, `conversation`, `details`, with identical kinds and scopes. Slot names are the composition contract, so `ui-sidebar`, `ui-conversation` and every registrant beneath them compose into the sidebar unchanged. The roster picks the shell: the browser app loads `ui-layout`, this webview loads its own.

**Panes are stacked routes, and they all stay mounted.** One pane is in front at a time, selected by CSS on a route in the shell's own store. Unmounting the others would discard scroll position, the composer draft, and the live subscriptions of a streaming turn, so `display: none` does the hiding. `ctx.layout` is implemented verbatim from the wide shell's `ILayout` — three methods — with only the meaning changed: toggling the sidebar routes between the sessions pane and the conversation, opening details brings that pane forward.

**Navigation is native.** The view contributes into `viewsContainers.secondarySidebar`, finalized in VS Code 1.106 and available to our `^1.125` engine range, so the extension lands in the right-hand sidebar without asking the user to drag it. Title actions own the navigation row: they cost the webview no pixels, the scarcest resource in a narrow column. The host retains the latest requested route until the webview reports that its page listener is installed; the page-level route channel then replays that value to `webview/route-bridge.ts`, and `NarrowLayoutService` retains it until the root store attaches. Routing stays separate from the API bridge message union while surviving both page and plugin boot.

**One lifecycle transaction owns the server, and protocol compatibility precedes GUI boot.** Starts publish one owned runtime candidate; restart and deactivation serialize through the same owner, detach the candidate before awaiting disposal, and a synchronous deactivation flag prevents queued or late work from publishing afterward. The extension retains server readiness until the page listener is installed, preventing an ordinary startup interval from being classified as incompatibility. After that signal, the webview bootstrap exposes only a temporary bridge for `host.describe`, requires the host's `protocolVersion` to match the bundled client, and publishes the bridge to `AppWebEntry` only on success. An older, newer, missing, or malformed version renders an incompatible-host state and starts neither the client graph nor its streams; the editor-native layer applies the same version requirement.

**The shell lives in the app, not in `packages/client`.** The VS Code sidebar is its only consumer, and the theme adapter beside it already establishes the webview-own-module precedent. A second narrow-container host is what would justify promoting it to a package.

**Fitting the occupants uses two mechanisms, picked by what each component measures itself against.** Anything sized by its container takes a `-host` variable: the component keeps its desktop value as the default (`var(--dsh-…-host, 32px)`) and the frame overrides it once, so the wide shell is untouched and the indirection is visible at the point that reads it. This covers the composer's clearances, card cap, dock inset, toolbar gaps and model-name cap, plus the hero's clearance and its glow — an asset deliberately wider than its own card, which a narrow host drops rather than pay a scrollbar for. The composer toolbar also gets permission to wrap, because its controls are fixed-size: past a point the only thing that fits them is a second line. Anything anchored to the viewport instead takes a media query: the settings modal (188px nav rail to a horizontal strip, appearance cubes from three rows to one) and the settings rows' 48px text inset, which alone was turning one-line titles into three. A webview is its own iframe, so `100vw` and media queries see the sidebar; the browser shell fires the same rules only when the window is genuinely that narrow, which is the behavior one would want anyway.

**`ThemePresenter` moved from `ui-layout` to `ui-theme`.** A replaceable shell must not own the palette's route to the document; the presenter now sits with the service whose snapshots it projects, and `ui-layout` no longer injects `theme` at all.

## Alternatives considered

- **Rewrite the presentation layer for narrow viewports** — the licensed-but-expensive reading of the request. Rejected as the *first* move: the measurements say only the shell, the settings modal, and the trajectory table are geometrically impossible, while message columns and cards use `max-width` caps that simply shrink. Substituting the shell buys a working sidebar now and leaves the per-component tightening as follow-up work with evidence behind each change.
- **Make the wide shell responsive** — one component set spanning 320px to 1920px means a breakpoint fork in every layout decision, and the three-column geometry has no meaningful narrow form. Two shells behind one slot contract keeps each honest.
- **New slot names for the narrow shell** — semantically cleaner (a sidebar has no "side" column) and it would have forced a narrow variant of every registrant before anything rendered. Reusing the names is what makes the substitution free.
- **Keep the editor-tab panel as a second surface** — deferred, not refused: the sidebar is the requested form, and one surface is cheaper to keep honest. The shell is reusable if a wide form is wanted later.
- **A tab bar inside the webview** — costs vertical pixels in the narrowest place and duplicates chrome VS Code already draws.

## Consequences

The sidebar renders the real GUI at a measured 259px with three panes mounted and one active, and the title actions route between them; verified in a real editor through the extension development host. Deterministic tests cover concurrent restart/deactivation, server-ready protocol gating, incompatible bridge protocols, ready/replay routing, the shell contract, and the one-shell roster substitution.

With the compact scale applied, a 259px sidebar reports zero horizontally overflowing elements and zero horizontal scrollers across the hero, the sessions pane, and the settings modal, including a composer carrying the full control set (attach, permission, model, send). The settings modal went from a content column of roughly 23px — a 188px rail inside a viewport-clamped panel — to the whole surface. Two clamps that would have overflowed their own container were fixed as pure logic rather than styling: the slash menu's 260px floor and the trajectory details pane's 320px floor now yield when the container is narrower than the floor itself.

The assembled browser snapshot boots the built webview through the production CSP at 259px against the keyless fixture and records sessions, question and approval composers, and representative Bash and Web Search rows through the Web lane's shared stable-ARIA/golden helper. The shell has no root-level horizontal scroll or uncontained overflow; a Markdown table retains one intentional content-level horizontal scroller. Browser launch failure closes the test server before propagating. A real provider turn inside an Extension Development Host remains manual until an editor-host lane exists.

Bundle weight is unchanged: it is dominated by the full plugin roster and `ui-primitives`' Markdown/KaTeX/shiki stack, which is a platform singleton in the web shell's seed. Trimming it is a separate question from layout, and this change deliberately does not touch it.
