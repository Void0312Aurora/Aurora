/**
 * The sidebar shell's implementation of the cross-plugin `ctx.layout` face.
 *
 * `ILayout` is the wide shell's contract, implemented here verbatim so every
 * plugin that reaches for a panel transition (ui-sidebar's collapse control,
 * ui-conversation's details entry) keeps working unchanged. Only the meaning
 * of a transition changes: with one pane visible at a time, opening a panel is
 * routing to it rather than widening a column.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { createNarrowStore, NarrowRoute } from './stores.ts'

/** The route store's bound action set (framework-baked, draft params peeled). */
export type RouteActions = BoundActions<ReturnType<typeof createNarrowStore>>

/** Cross-plugin panel-action face (ctx.layout) for a single-pane shell. */
export class NarrowLayoutService implements ILayout {
  #routes: RouteActions | undefined
  #pendingRoute: NarrowRoute | undefined

  /**
   * Adopt the root entry's bound store actions. Called from the root
   * registration's inject hook (a sanctioned assembly side effect), so the
   * face is live from the entry's first render; on entry re-register the
   * fresh actions overwrite the stale set.
   * @param actions - bound actions of the entry's route store instance.
   */
  attachRoutes(actions: RouteActions): void {
    this.#routes = actions
    if (this.#pendingRoute !== undefined) {
      actions.show(this.#pendingRoute)
      this.#pendingRoute = undefined
    }
  }

  /**
   * Route to a pane directly. Wider than `ILayout`, which only knows panel
   * transitions: a host driving navigation from outside the page (the VS Code
   * title-bar actions) needs an idempotent destination, not a toggle.
   * @param route - the pane to bring to the front.
   */
  show(route: NarrowRoute): void {
    if (this.#routes === undefined) {
      this.#pendingRoute = route
      return
    }
    this.#routes.show(route)
  }

  /** Route between the sessions pane and the conversation. */
  toggleSidebar(): void {
    this.#require().toggleSessions()
  }

  /** Bring the details pane to the front. */
  openDetails(): void {
    this.#require().openDetails()
  }

  /** Leave the details pane for the conversation. */
  closeDetails(): void {
    this.#require().closeDetails()
  }

  #require(): RouteActions {
    // Callers are UI gestures, which cannot fire before the root entry
    // rendered (the inject hook runs in its first render) — reaching this
    // unwired is a boot-order bug, not a race to tolerate.
    if (this.#routes === undefined) throw new Error('layout: route actions not wired (root entry not mounted)')
    return this.#routes
  }
}
