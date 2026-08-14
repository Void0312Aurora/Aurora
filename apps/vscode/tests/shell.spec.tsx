// @vitest-environment jsdom
// The sidebar shell: ctx.layout provided, ONE register() call declaring the
// same three child slots the wide shell declares (so existing occupants
// compose unchanged), the route store seated, the route actions wired through
// the inject hook, and the frame keeping every pane mounted while CSS selects
// the front one.

import { Context } from 'cordis'
import { render } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../webview/shell/index.ts'
import { NarrowLayoutService } from '../webview/shell/service.ts'
import { createNarrowStore, type NarrowRoute } from '../webview/shell/stores.ts'
import { NarrowFrame, type NarrowFrameProps } from '../webview/shell/NarrowFrame.tsx'

/** jsdom has no ResizeObserver; the frame measures its container through one. */
class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotsService).await()
  return { ctx, slots: ctx.get('slots') as SlotsService }
}

describe('sidebar shell apply', () => {
  it('declares its service dependencies', () => {
    expect(inject).toEqual(['slots'])
  })

  it('provides ctx.layout and registers the frame into root with the wide shell\'s child declarations', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(ctx.get('layout')).toBeInstanceOf(NarrowLayoutService)
    expect(slots.entries('root')).toHaveLength(1)
    // Same names, kinds and scopes as ui-layout: that parity is what lets
    // ui-sidebar / ui-conversation register without a change.
    expect(slots.spec('sidebar')).toEqual({ kind: 'single', scope: 'root' })
    expect(slots.spec('conversation')).toEqual({ kind: 'single', scope: 'session-maybe' })
    expect(slots.spec('details')).toEqual({ kind: 'single', scope: 'session' })
  })

  it('routes ctx.layout gestures through the entry\'s bound store actions', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entry = slots.entries('root')[0]!
    const instance = (entry.store as ReturnType<typeof createNarrowStore>).create()
    const injected = (entry.inject as unknown as (a: typeof instance.actions) => object)(instance.actions)
    expect(injected).toEqual({})

    const layout = ctx.get('layout') as NarrowLayoutService
    expect(instance.getSnapshot().route).toBe('chat')
    layout.toggleSidebar()
    expect(instance.getSnapshot().route).toBe('sessions')
    // The same gesture returns to the conversation.
    layout.toggleSidebar()
    expect(instance.getSnapshot().route).toBe('chat')
    layout.openDetails()
    expect(instance.getSnapshot().route).toBe('details')
    layout.closeDetails()
    expect(instance.getSnapshot().route).toBe('chat')
    // The host's title-bar actions need an idempotent destination.
    layout.show('sessions')
    layout.show('sessions')
    expect(instance.getSnapshot().route).toBe('sessions')
  })

  it('throws when a gesture arrives before the root entry mounted', () => {
    const layout = new NarrowLayoutService()
    expect(() => { layout.toggleSidebar() }).toThrow(/route actions not wired/)
    expect(() => { layout.openDetails() }).toThrow(/route actions not wired/)
    expect(() => { layout.closeDetails() }).toThrow(/route actions not wired/)
    expect(() => { layout.show('chat') }).toThrow(/route actions not wired/)
  })

  it('teardown unwinds the service, the root registration, and the child declarations', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(ctx.get('layout')).toBeUndefined()
    expect(slots.entries('root')).toHaveLength(0)
    expect(slots.spec('sidebar')).toBeUndefined()
    expect(slots.spec('conversation')).toBeUndefined()
    expect(slots.spec('details')).toBeUndefined()
  })
})

describe('the route store', () => {
  it('closeDetails only leaves the details pane, never hijacks another route', () => {
    const instance = createNarrowStore().create()
    instance.actions.show('sessions')
    instance.actions.closeDetails()
    // Still on sessions: the user was not on details, so nothing to close.
    expect(instance.getSnapshot().route).toBe('sessions')
    instance.actions.openDetails()
    instance.actions.closeDetails()
    expect(instance.getSnapshot().route).toBe('chat')
  })
})

/** Bind a real store instance into the store share the framework would supply. */
function storeShare(route: NarrowRoute) {
  const instance = createNarrowStore().create()
  instance.actions.show(route)
  const snapshot = instance.getSnapshot()
  return {
    useStore<T>(select: (s: typeof snapshot) => T) {
      return select(snapshot)
    },
    actions: instance.actions,
  }
}

/** Render the frame with recording slot stubs. */
function mount(route: NarrowRoute) {
  const owners: Record<string, unknown> = {}
  const props = {
    ...storeShare(route),
    renderSlot: (name: string, owner: unknown) => {
      owners[name] = owner
      return <div data-testid={`slot-${name}`}>{name}</div>
    },
  } as unknown as NarrowFrameProps
  const view = render(<NarrowFrame {...props} />)
  return { view, owners }
}

describe('NarrowFrame', () => {
  it('mounts every pane regardless of route so no pane loses its state', () => {
    const { view } = mount('chat')
    // All three rendered, not just the active one.
    expect(view.queryByTestId('slot-conversation')).not.toBeNull()
    expect(view.queryByTestId('slot-sidebar')).not.toBeNull()
    expect(view.queryByTestId('slot-details')).not.toBeNull()
  })

  it('marks exactly the routed pane active', () => {
    for (const route of ['chat', 'sessions', 'details'] as const) {
      const { view } = mount(route)
      const active = view.container.querySelectorAll('[data-active="true"]')
      expect(active).toHaveLength(1)
      const expected = route === 'chat' ? 'conversation' : route === 'sessions' ? 'sidebar' : 'details'
      expect(active[0]?.textContent).toBe(expected)
      view.unmount()
    }
  })

  it('tells the sidebar occupant it is never collapsed and hands it a width', () => {
    const { owners } = mount('sessions')
    const sidebar = owners['sidebar'] as { collapsed: boolean; width: number }
    expect(sidebar.collapsed).toBe(false)
    expect(sidebar.width).toBeTypeOf('number')
    expect(owners['conversation']).toEqual({})
    expect(owners['details']).toEqual({})
  })
})
