/**
 * The sidebar shell: a webview-own plugin (like the theme adapter next to it,
 * not an npm package) for editor sidebars and other containers too narrow for
 * columns. One register() call contributes NarrowFrame into the runtime's
 * built-in 'root' slot and declares the same three child slots the wide shell
 * declares, seats the route store, and wires the panel-action service face.
 *
 * This plugin and `@deepseek-ai/dsh-client-ui-layout` are mutually exclusive:
 * 'root' takes a single occupant, so loading both fails loud at registration.
 * The roster picks one — the browser app loads the wide shell, this webview
 * loads this shell. Reusing the wide shell's slot NAMES is the point:
 * ui-sidebar, ui-conversation and their sub-registrants compose here without
 * a single change, and only the arrangement differs.
 *
 * It lives here rather than in `packages/client` because the VS Code sidebar
 * is its only consumer; a second narrow-container host is what would justify
 * promoting it to a package. The `ILayout` contract and the three child-slot
 * SlotMap declarations belong to the wide shell package and are pulled in
 * type-only, so both shells speak one contract with no runtime dependency.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { RouteActions } from './service.ts'
import { NarrowFrame } from './NarrowFrame.tsx'
import { createNarrowStore } from './stores.ts'
import { NarrowLayoutService } from './service.ts'

/** Required services (cordis fiber inject — the loader passes the whole export surface as an object plugin). */
export const inject = ['slots']

/**
 * Client plugin body: provide ctx.layout, then one register() call —
 * NarrowFrame into 'root' with the three child-slot declarations, the route
 * store seat, and the inject hook that hands the store's bound actions to the
 * service.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const layout = new NarrowLayoutService()
  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'conversation': { kind: 'single', scope: 'session-maybe' },
        'details': { kind: 'single', scope: 'session' },
      },
      store: createNarrowStore,
      // The hook's only side effect connects the root store to ctx.layout.
      inject: (actions: RouteActions) => {
        layout.attachRoutes(actions)
        return {}
      },
    }, NarrowFrame)
    return () => {
      disposeRegistration()
      // provide()'s disposer settles asynchronously; teardown is synchronous fire-and-forget.
      void disposeService()
    }
  }, 'dsh-vscode-shell: service + root registration')
}
