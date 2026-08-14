/**
 * Single-pane shell frame for editor sidebars, registered into the built-in
 * 'root' slot in place of the three-column AppFrame. It declares the SAME
 * child slots as the wide shell (`sidebar` / `conversation` / `details`), so
 * every existing occupant registers unchanged; what differs is that the panes
 * are stacked routes rather than columns, since a 300-400px container cannot
 * carry three of them side by side.
 *
 * All three panes stay mounted and CSS selects the front one: unmounting would
 * discard scroll position, the composer draft, and a streaming turn's live
 * subscriptions. Pure component — everything arrives through the framework
 * shares; zero cordis imports, zero self-made hooks.
 */
import { useEffect, useRef, useState } from 'react'
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createNarrowStore } from './stores.ts'
import css from './NarrowFrame.module.css'

/** Full composed props: runtime share + child-slot render share + store share. */
export type NarrowFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'conversation' | 'details'>
  & PropsStore<ReturnType<typeof createNarrowStore>>

/** Width reported to the sidebar occupant before the first measurement lands. */
const ASSUMED_WIDTH = 320

/** The single-pane frame (see module doc). */
export function NarrowFrame({ useStore, renderSlot }: NarrowFrameProps) {
  const route = useStore(s => s.route)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(ASSUMED_WIDTH)

  // The sidebar occupant lays itself out against a real width; in a sidebar
  // that width is the whole container and the user can drag it at any time.
  useEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const measured = el.getBoundingClientRect().width
        if (measured > 0) setWidth(measured)
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <div ref={frameRef} className={css.frame} data-route={route}>
      <div className={css.pane} data-active={route === 'chat'}>
        {renderSlot('conversation', {})}
      </div>
      <div className={css.pane} data-active={route === 'sessions'}>
        {/* Never collapsed: a routed pane is either the whole width or absent,
            so the wide shell's compact rail has no counterpart here. */}
        {renderSlot('sidebar', { collapsed: false, width })}
      </div>
      <div className={css.pane} data-active={route === 'details'}>
        {/* Strict session scope: renders empty while no session is current. */}
        {renderSlot('details', {})}
      </div>
    </div>
  )
}
