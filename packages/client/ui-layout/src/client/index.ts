/**
 * Layout plugin, browser half: one register() call contributes AppFrame into
 * the runtime's built-in 'root' slot and, in the same breath, declares the
 * four child slots (declaration = exclusive render authority), seats the
 * layout store (panel geometry), and wires the panel-action service face.
 * ctx.layout is the cross-plugin panel-action seam; navigation state lives
 * with the runtime sessions service. Theme projection onto the document is
 * ui-theme's own presenter, not this shell's — a replaceable shell must not
 * own it.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { PanelActions } from './service.ts'
import { AppFrame } from './AppFrame.tsx'
import { createLayoutStore } from './stores.ts'
import { LayoutService } from './service.ts'

// Contract surface only (export-convergence rule: cross-package consumers
// keep a symbol exported; test-only/package-internal symbols live off /src).
// ILayout: the ctx.layout face consumers and test fakes type against.
// OwnerShare contracts below are the render-side halves registrants compose
// against; the frame components and the store factory are package-internal.
export { LayoutService } from './service.ts'
export type { ILayout } from './service.ts'

declare module 'cordis' {
  interface Context {
    /** The outward face only; the concrete service stays inside this plugin. */
    layout: import('./service.ts').ILayout
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    // The 'root' entry itself is the runtime's built-in slot (declared
    // there); these four are the frame's children, declared by the same
    // register() call that contributes AppFrame. Session owners never pass
    // sessionId: the framework injects it as a standard prop.
    'sidebar': { kind: 'single'; scope: 'root'; owner: SidebarOwnerProps }
    // Current-session-optional: the occupant owns both the no-session hero
    // and live conversation states without changing its React identity.
    'conversation': { kind: 'single'; scope: 'session-maybe'; owner: ConvOwnerProps }
    'details': { kind: 'single'; scope: 'session'; owner: DetailsOwnerProps }
  }
}

// OwnerShare contracts — the render-side share the slot owner supplies at
// renderSlot. Registrants IMPORT these and compose their full component props
// through the four-share intersection (PropsRuntime & PropsRenderSlots &
// PropsStore & I). Conversation business state and actions arrive through
// framework-standard hooks and each registrant's inject face, not owner props.

/** Sidebar owner share: live column state from the frame's concession solve. */
export interface SidebarOwnerProps {
  /** True when the sidebar is closed (the column renders the compact control rail). */
  collapsed: boolean
  /** Rendered column width in px (SIDEBAR_COLLAPSED when collapsed). */
  width: number
}

/** Conversation owner share: business state and actions belong to the registrant. */
export interface ConvOwnerProps {}

/** Details owner share: empty — sessionId arrives as a framework-standard prop. */
export interface DetailsOwnerProps {}

/**
 * Required services (cordis fiber inject — the loader passes the whole export
 * surface as an object plugin). Theme is absent on purpose: ui-theme seats its
 * own document presenter, and every plugin's apply completes before the shell
 * renders, so the palette is on the page by the first frame without an edge
 * here.
 */
export const inject = ['slots']

/**
 * Client plugin body: provide ctx.layout, then one register() call — AppFrame
 * into 'root' with the four child-slot declarations, the layout store seat,
 * and the inject hook that hands the store's bound actions to the service.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const layout = new LayoutService()
  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'conversation': { kind: 'single', scope: 'session-maybe' },
        'details': { kind: 'single', scope: 'session' },
      },
      // Exclusive store: the factory itself — the framework instantiates per
      // entry and delivers useStore/actions to AppFrame as standard props.
      store: createLayoutStore,
      // The hook's only side effect connects the root store to ctx.layout;
      // conversation business actions belong to their registrants.
      inject: (actions: PanelActions) => {
        layout.attachPanels(actions)
        return {}
      },
    }, AppFrame)
    return () => {
      disposeRegistration()
      // provide()'s disposer settles asynchronously; teardown is synchronous fire-and-forget.
      void disposeService()
    }
  }, 'ui-layout: service + root registration')
}
