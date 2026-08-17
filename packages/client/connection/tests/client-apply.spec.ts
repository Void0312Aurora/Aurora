/**
 * Connection plugin browser-half apply: ctx.connection handle mounting, mode
 * selection off the page URL, and the single-consumer stream-loop ownership.
 */
import { Context } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, type ConnectionHandle } from '../src/client/index.ts'
import { FixtureApiClient } from '../src/client/fixture.ts'
import { WebApiClient } from '../src/client/web-api-client.ts'
import { PostMessageApiClient } from '../src/client/webview-bridge.ts'

type Win = { location?: { hostname: string; search: string } }

afterEach(() => {
  delete (globalThis as Win).location
  globalThis.__DSH_WEBVIEW_BRIDGE__ = undefined
})

async function mount(): Promise<ConnectionHandle> {
  const ctx = new Context()
  await ctx.plugin({ apply, inject: [] })
  const handle = ctx.get('connection') as ConnectionHandle | undefined
  if (handle === undefined) throw new Error('ctx.connection not provided')
  return handle
}

describe('connection client apply', () => {
  it('gives a real loopback page Host-only capability', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '' }
    const handle = await mount()
    expect(handle.api).toBeInstanceOf(WebApiClient)
    expect(handle.isLoopback).toBe(true)
  })

  it('keeps fixture transport Hostless even when its document is served from loopback', async () => {
    ;(globalThis as Win).location = { hostname: '127.0.0.1', search: '?fixture' }
    const fixture = await mount()
    expect(fixture.api).toBeInstanceOf(FixtureApiClient)
    expect(fixture.isLoopback).toBe(false)
  })

  it('uses the real client and loopback capability when no browser location exists', async () => {
    delete (globalThis as Win).location
    const handle = await mount()
    expect(handle.api).toBeInstanceOf(WebApiClient)
    expect(handle.isLoopback).toBe(true)
  })

  it('reports non-loopback page authority through the connection handle', async () => {
    ;(globalThis as Win).location = { hostname: '192.0.2.20', search: '' }
    expect((await mount()).isLoopback).toBe(false)
  })

  it('gives the webview bridge Host capability regardless of page authority or fixture query', async () => {
    // A non-loopback page authority (the embedder origin) must not matter:
    // the bridge reaches the server through the extension host's loopback fetch.
    ;(globalThis as Win).location = { hostname: 'webview.invalid', search: '?fixture' }
    globalThis.__DSH_WEBVIEW_BRIDGE__ = {
      postMessage: () => {},
      onMessage: () => () => {},
    }
    const handle = await mount()
    // The bridge wins over the ?fixture switch too.
    expect(handle.api).toBeInstanceOf(PostMessageApiClient)
    expect(handle.isLoopback).toBe(true)
  })

  it('start() hands out one loop, rejects a second consumer, and stop() aborts the streams', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    // config omitted: the `config ?? {}` default arm is part of the surface.
    const loop = handle.start({})
    expect(() => handle.start({})).toThrow(/already owned by another consumer/)
    loop.stop() // teardown must not throw; the fixture streams abort quietly
  })

  it('WebApiClient carries requests over globalThis.fetch', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '' }
    const handle = await mount()
    const original = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = (input: URL | RequestInfo) => {
      seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }
    try {
      // Schema rejection is fine — the transport hop is the assertion.
      await (handle.api as WebApiClient).host.describe({}).catch(() => { return undefined })
    } finally {
      globalThis.fetch = original
    }
    expect(seen.some(u => u.includes('/api/'))).toBe(true)
  })
})
