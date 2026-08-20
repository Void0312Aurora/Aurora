/**
 * The sidebar shell's route store: which of the three panes is in front. Width
 * has no place here — a sidebar pane fills the container, so there is no panel
 * geometry to remember, only the current route. Module level exports the
 * factory only (a module-level handle would be a de-facto singleton surviving
 * plugin reloads).
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * The panes a narrow shell can show. `chat` is the resident one; the others
 * are the wide shell's side columns promoted to full-width routes.
 */
export type NarrowRoute = 'chat' | 'sessions' | 'details'

/** Narrow shell state: the pane currently in front. */
type NarrowState = { route: NarrowRoute }

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type NarrowActions = {
  show: (draft: NarrowState, route: NarrowRoute) => void
  toggleSessions: (draft: NarrowState) => void
  openDetails: (draft: NarrowState) => void
  closeDetails: (draft: NarrowState) => void
}

/**
 * Create the narrow shell's route store handle. The route is deliberately not
 * persisted: a sidebar reopens on the conversation, not on whatever pane the
 * last session ended on.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createNarrowStore(): EngineStoreHandle<NarrowState, NarrowActions> {
  return defineStore({
    init: (): NarrowState => { return ({ route: 'chat' }) },
    actions: {
      show: (d, route: NarrowRoute) => { d.route = route },
      // The wide shell's sidebar toggle becomes a route flip: the same gesture
      // (ui-sidebar's collapse control) returns the user to the conversation.
      toggleSessions: (d) => { d.route = d.route === 'sessions' ? 'chat' : 'sessions' },
      openDetails: (d) => { d.route = 'details' },
      // Closing details lands on the conversation, never on a stale pane.
      closeDetails: (d) => { if (d.route === 'details') d.route = 'chat' },
    },
  })
}
