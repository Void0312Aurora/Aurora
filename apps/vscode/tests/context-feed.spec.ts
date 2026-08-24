/**
 * IDE-context feed: nudges debounce into one flush, an unchanged signature is
 * suppressed after the first inject, switching sessions or files re-injects, a
 * no-active-session or empty snapshot injects nothing, and a rejected/failed
 * inject does not record the signature (so the next nudge retries). The client,
 * editor sampler, active-session resolver, and scheduler are all injected.
 */

import { describe, expect, it } from 'vitest'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { EditorState, SampleLimits } from '../src/ide-context.ts'
import { IdeContextFeed } from '../src/context-feed.ts'

const LIMITS: SampleLimits = { maxTextChars: 100, maxDiagnostics: 5 }

type InjectResult = RpcResponse<{ accepted: true }>

/** A synchronous scheduler: the feed's debounced run fires when `tick()` is called. */
function manualScheduler() {
  let queued: (() => void) | undefined
  return {
    schedule: (fn: () => void) => { queued = fn; return { cancel: () => { if (queued === fn) queued = undefined } } },
    tick: () => { const fn = queued; queued = undefined; fn?.() },
    pending: () => queued !== undefined,
  }
}

function feedWith(options: {
  editor: () => EditorState
  session: () => string | undefined
  respond?: (sessionId: string, signal: AbortSignal | undefined) => InjectResult | Promise<InjectResult>
}) {
  const scheduler = manualScheduler()
  const injected: { sessionId: string; text: string }[] = []
  const client = {
    sessions: {
      injectContext: (payload: { sessionId: string; content: { type: string; text?: string }[] }, signal?: AbortSignal) => {
        injected.push({ sessionId: payload.sessionId, text: payload.content[0]?.text ?? '' })
        const result = options.respond?.(payload.sessionId, signal)
          ?? { rpcId: 'r' as never, result: { ok: true as const, value: { accepted: true as const } } }
        return Promise.resolve(result)
      },
    },
  } as unknown as Pick<IApiClient, 'sessions'>
  const feed = new IdeContextFeed({
    client,
    readEditorState: options.editor,
    activeSession: options.session,
    limits: LIMITS,
    log: () => {},
    schedule: scheduler.schedule,
  })
  return { feed, scheduler, injected }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('IdeContextFeed', () => {
  it('collapses a burst of nudges into one debounced inject', async () => {
    const { feed, scheduler, injected } = feedWith({
      editor: () => ({ path: 'a.ts', selection: 'x', range: { start: 1, end: 1 }, diagnostics: [] }),
      session: () => 's1',
    })
    feed.nudge()
    feed.nudge()
    feed.nudge()
    scheduler.tick()
    await settle()
    expect(injected).toHaveLength(1)
    expect(injected[0]).toMatchObject({ sessionId: 's1' })
    expect(injected[0]?.text).toContain('[editor context]')
  })

  it('suppresses an unchanged signature and re-injects when the file changes', async () => {
    let path = 'a.ts'
    const { feed, scheduler, injected } = feedWith({
      editor: () => ({ path, diagnostics: [] }),
      session: () => 's1',
    })
    feed.nudge(); scheduler.tick(); await settle()
    feed.nudge(); scheduler.tick(); await settle() // identical → suppressed
    expect(injected).toHaveLength(1)
    path = 'b.ts'
    feed.nudge(); scheduler.tick(); await settle() // changed → injects
    expect(injected).toHaveLength(2)
  })

  it('re-injects the same context into a different session', async () => {
    let session = 's1'
    const { feed, scheduler, injected } = feedWith({
      editor: () => ({ path: 'a.ts', diagnostics: [] }),
      session: () => session,
    })
    feed.nudge(); scheduler.tick(); await settle()
    session = 's2'
    feed.nudge(); scheduler.tick(); await settle()
    expect(injected.map(i => i.sessionId)).toEqual(['s1', 's2'])
  })

  it('samples immediately when a session becomes active, ahead of the debounce', async () => {
    const state: { session?: string } = {}
    const { feed, scheduler, injected } = feedWith({
      editor: () => ({ path: 'already-open.ts', selection: 'const ready = true', range: { start: 1, end: 1 }, diagnostics: [] }),
      session: () => state.session,
    })
    feed.nudge()
    expect(scheduler.pending()).toBe(true)
    state.session = 'new-session'
    await feed.sync()
    expect(scheduler.pending()).toBe(false)
    expect(injected).toHaveLength(1)
    expect(injected[0]?.sessionId).toBe('new-session')
    expect(injected[0]?.text).toContain('already-open.ts')
  })

  it('shares one explicit-session prime between active change and first prompt', async () => {
    let release!: (result: InjectResult) => void
    const deferred = new Promise<InjectResult>((resolve) => { release = resolve })
    const { feed, injected } = feedWith({
      editor: () => ({ path: 'explicit.ts', diagnostics: [] }),
      session: () => 'heuristic-session',
      respond: () => deferred,
    })

    const activePrime = feed.beforeFirstPrompt('prompt-session')
    const promptPrime = feed.beforeFirstPrompt('prompt-session')
    expect(injected.map(item => item.sessionId)).toEqual(['prompt-session'])
    release({ rpcId: 'r' as never, result: { ok: true, value: { accepted: true } } })
    await Promise.all([activePrime, promptPrime])
    expect(injected).toHaveLength(1)
  })

  it('forgets prime state with the session so a reused id is admitted again', async () => {
    const { feed, injected } = feedWith({
      editor: () => ({ path: 'a.ts', diagnostics: [] }),
      session: () => 's1',
    })
    await feed.beforeFirstPrompt('s1')
    feed.forget('s1')
    await feed.beforeFirstPrompt('s1')
    expect(injected).toHaveLength(2)
  })

  it('injects nothing without an active session or an active editor', async () => {
    const noSession = feedWith({ editor: () => ({ path: 'a.ts', diagnostics: [] }), session: () => undefined })
    noSession.feed.nudge(); noSession.scheduler.tick(); await settle()
    expect(noSession.injected).toHaveLength(0)

    const noEditor = feedWith({ editor: () => ({ diagnostics: [] }), session: () => 's1' })
    noEditor.feed.nudge(); noEditor.scheduler.tick(); await settle()
    expect(noEditor.injected).toHaveLength(0)
  })

  it('does not record the signature when the inject is rejected, so the next nudge retries', async () => {
    let ok = false
    const { feed, scheduler, injected } = feedWith({
      editor: () => ({ path: 'a.ts', diagnostics: [] }),
      session: () => 's1',
      respond: () => ok
        ? { rpcId: 'r' as never, result: { ok: true as const, value: { accepted: true as const } } }
        : { rpcId: 'r' as never, result: { ok: false as const, error: { code: 'agent-busy', message: 'busy', details: { reason: 'x' } } } },
    })
    feed.nudge(); scheduler.tick(); await settle() // rejected, signature not recorded
    ok = true
    feed.nudge(); scheduler.tick(); await settle() // same context retried, now accepted
    expect(injected).toHaveLength(2)
  })

  it('serializes overlapping flushes: no duplicate send, trailing re-sample runs once', async () => {
    // A slow inject lets a second flush arrive mid-send; it must not start a
    // second concurrent send, and the trailing run re-samples the latest state.
    let releaseFirst: (() => void) | undefined
    let path = 'a.ts'
    const scheduler = manualScheduler()
    const injected: string[] = []
    const client = {
      sessions: {
        injectContext: (payload: { content: { text?: string }[] }) => {
          injected.push(payload.content[0]?.text ?? '')
          if (injected.length === 1) {
            return new Promise<InjectResult>((resolve) => {
              releaseFirst = () => { resolve({ rpcId: 'r' as never, result: { ok: true, value: { accepted: true } } }) }
            })
          }
          return Promise.resolve<InjectResult>({ rpcId: 'r' as never, result: { ok: true, value: { accepted: true } } })
        },
      },
    } as unknown as Pick<IApiClient, 'sessions'>
    const feed = new IdeContextFeed({
      client,
      readEditorState: () => ({ path, diagnostics: [] }),
      activeSession: () => 's1',
      limits: LIMITS,
      log: () => {},
      schedule: scheduler.schedule,
    })

    feed.nudge(); scheduler.tick(); await settle() // first send starts, awaiting release
    expect(injected).toHaveLength(1)
    path = 'b.ts' // the file changed while the first send is in flight
    feed.nudge(); scheduler.tick(); await settle() // must NOT start a second concurrent send
    expect(injected).toHaveLength(1)
    releaseFirst?.(); await settle() // first completes → trailing run re-samples 'b.ts'
    expect(injected).toHaveLength(2)
    expect(injected[1]).toContain('b.ts')
  })

  it('cancels a pending flush on dispose', async () => {
    const { feed, scheduler, injected } = feedWith({
      editor: () => ({ path: 'a.ts', diagnostics: [] }),
      session: () => 's1',
    })
    feed.nudge()
    expect(scheduler.pending()).toBe(true)
    feed.dispose()
    scheduler.tick()
    await settle()
    expect(injected).toHaveLength(0)
  })

  it('aborts an in-flight send and fences dirty trailing work after dispose', async () => {
    let session = 's1'
    let editorReads = 0
    let release!: (result: InjectResult) => void
    let observedSignal: AbortSignal | undefined
    const deferred = new Promise<InjectResult>((resolve) => { release = resolve })
    const { feed, scheduler, injected } = feedWith({
      editor: () => { editorReads++; return { path: `${session}.ts`, diagnostics: [] } },
      session: () => session,
      respond: (_sessionId, signal) => { observedSignal = signal; return deferred },
    })

    feed.nudge(); scheduler.tick(); await settle()
    expect(injected.map(item => item.sessionId)).toEqual(['s1'])
    session = 's2'
    feed.nudge(); scheduler.tick(); await settle()
    feed.dispose()
    expect(observedSignal?.aborted).toBe(true)
    release({ rpcId: 'r' as never, result: { ok: true, value: { accepted: true } } })
    await settle()
    expect(injected.map(item => item.sessionId)).toEqual(['s1'])
    expect(editorReads).toBe(1)
  })
})
