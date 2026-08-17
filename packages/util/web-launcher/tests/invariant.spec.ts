import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as WebLauncherInvariant from '../src/invariant.ts'

describe('web-launcher invariant companion', () => {
  it('registers its explained empty runtime invariant', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantService)
    const fiber = await ctx.plugin(WebLauncherInvariant)

    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-web-launcher', () => {})
    }).toThrow(/already registered/)
    await fiber.dispose()
    const dispose = ctx.invariants.register('@deepseek-ai/dsh-web-launcher', () => {})
    dispose()
    await ctx.fiber.dispose()
  })
})
