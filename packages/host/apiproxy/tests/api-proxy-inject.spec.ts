/**
 * session.injectContext routing: the wire request reaches Agent.inject with
 * the fixed IDE provenance and the originating rpcId, while gateway errors
 * remain stable for disposed or missing agents.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ApiProxy, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`inject-${String(nextRpc++)}`), payload }
}

async function harness(): Promise<{
  ctx: Context
  api: ApiProxy
  attach: (session: Session, inject: (message: UserMessage) => void) => void
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  return {
    ctx,
    api: createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }),
    attach: (session, inject) => {
      ctx.agents.register({ id: session.id, session, status: 'idle', ctx, inject } as unknown as Agent)
    },
  }
}

describe('session.injectContext', () => {
  it('routes content to Agent.inject with IDE provenance and rpcId', async () => {
    const { ctx, api, attach } = await harness()
    const session = ctx.sessions.create()
    const injected: UserMessage[] = []
    attach(session, (message) => { injected.push(message) })
    const call = request({ sessionId: session.id, content: [{ type: 'text' as const, text: 'editor context' }] })

    const response = await api.sessions.injectContext(call)

    expect(response.rpcId).toBe(call.rpcId)
    expect(response.result).toEqual({ ok: true, value: { accepted: true } })
    expect(injected).toHaveLength(1)
    expect(injected[0]?.content).toEqual([{ type: 'text', text: 'editor context' }])
    expect(injected[0]?.source).toEqual({ kind: 'plugin', plugin: 'ide', rpcId: call.rpcId })
  })

  it('maps a synchronous inject throw to agent-busy', async () => {
    const { ctx, api, attach } = await harness()
    const session = ctx.sessions.create()
    attach(session, () => { throw new Error('disposed') })

    const response = await api.sessions.injectContext(
      request({ sessionId: session.id, content: [{ type: 'text' as const, text: 'editor context' }] }),
    )

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('expected an error result')
    expect(response.result.error.code).toBe('agent-busy')
    expect(response.result.error.details).toEqual({ reason: expect.stringContaining('disposed') as unknown })
  })

  it('does not inject an unknown session', async () => {
    const { api } = await harness()
    const response = await api.sessions.injectContext(
      request({ sessionId: 'missing-session' as never, content: [{ type: 'text' as const, text: 'editor context' }] }),
    )
    expect(response.result.ok).toBe(false)
  })
})
