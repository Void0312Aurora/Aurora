import { describe, expect, it } from 'vitest'
import { verifyHostProtocol } from '../src/host-client.ts'

function response(value: unknown): { result: { ok: true; value: never } } {
  return { result: { ok: true, value: value as never } }
}

describe('verifyHostProtocol', () => {
  it('accepts the current protocol version', async () => {
    const result = await verifyHostProtocol({
      host: { describe: async () => response({ protocolVersion: 1, version: 'v' }) } as never,
    })
    expect(result).toEqual({ ok: true, hostVersion: 'v' })
  })

  it('rejects a mismatched protocol version before native clients start', async () => {
    const result = await verifyHostProtocol({
      host: { describe: async () => response({ protocolVersion: 2, version: 'old' }) } as never,
    })
    expect(result).toEqual({ ok: false, reason: 'host protocolVersion 2 != client 1' })
  })

  it('turns a missing or malformed protocol field into a compatibility failure', async () => {
    const result = await verifyHostProtocol({
      host: { describe: async () => { throw new Error('protocolVersion: Required') } } as never,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected protocol failure')
    expect(result.reason).toContain('protocol response invalid')
  })
})
