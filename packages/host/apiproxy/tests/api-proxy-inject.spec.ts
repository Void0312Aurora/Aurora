/**
 * session.injectContext behavior at the gateway layer: the wire request routes
 * to `Agent.inject` with the `ide-context` provenance (plugin kind, fixed
 * 'ide' tag, the request's rpcId), content passes through verbatim, and a
 * synchronous inject throw maps to the stable `agent-busy` error. The
 * no-wakeup/staging semantics of inject itself belong to the agent-loop
 * suites; this layer asserts only its own routing and provenance.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ApiProxy, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`inject-${String(nextRpc++)}`), payload }
}

interface InjectHarness {
  ctx: Context
  api: ApiProxy
  attach: (session: Session, inject: (message: UserMessage) => void) => void
}

async function harness(): Promise<InjectHarness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserInteractionService)
  await ctx.plugin(AgentRegistry)
  return {
    ctx,
    api: createApiProxy(ctx, { provider: 'p', model: 'm', cwd: '/tmp', workspaceRoot: '/tmp' }),
    attach: (session, inject) => {
      ctx.agents.register({ id: session.id, session, status: 'idle', ctx, inject } as unknown as Agent)
    },
  }
}

describe('session.injectContext', () => {
  it('routes content to Agent.inject with the ide-context provenance', async () => {
    const { ctx, api, attach } = await harness()
    const session = ctx.sessions.create()
    const injected: UserMessage[] = []
    attach(session, (message) => { injected.push(message) })

    const call = request({ sessionId: session.id, content: [{ type: 'text' as const, text: '编辑器上下文' }] })
    const response = await api.sessions.injectContext(call)

    expect(response.rpcId).toBe(call.rpcId)
    expect(response.result).toEqual({ ok: true, value: { accepted: true } })
    expect(injected).toHaveLength(1)
    expect(injected[0]?.content).toEqual([{ type: 'text', text: '编辑器上下文' }])
    // Provenance: plugin kind (model face carries no transport vocabulary),
    // the fixed 'ide' tag, and the request's rpcId for durable audit.
    expect(injected[0]?.source).toEqual({ kind: 'plugin', plugin: 'ide', rpcId: call.rpcId })
    expect(injected[0]?.role).toBe('user')
  })

  it('maps a synchronous inject throw to agent-busy with the reason attached', async () => {
    const { ctx, api, attach } = await harness()
    const session = ctx.sessions.create()
    attach(session, () => { throw new Error('disposed') })

    const response = await api.sessions.injectContext(
      request({ sessionId: session.id, content: [{ type: 'text' as const, text: 'ctx' }] }),
    )

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('expected an error result')
    expect(response.result.error.code).toBe('agent-busy')
    expect(response.result.error.details).toEqual({ reason: expect.stringContaining('disposed') as unknown })
  })

  it('fails an unknown session with an error result instead of injecting', async () => {
    const { api } = await harness()
    const response = await api.sessions.injectContext(
      request({ sessionId: 'missing-session' as never, content: [{ type: 'text' as const, text: 'ctx' }] }),
    )
    // The exact code (session-not-found vs internal) belongs to the shared
    // agentFor resolution layer, asserted by the cold-session suite; this
    // layer only guarantees injectContext takes that same path.
    expect(response.result.ok).toBe(false)
  })
})
