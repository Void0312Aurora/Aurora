// Boots the shipped Web composition over the built dist this lane already uses
// and asserts what that composition produces: the model-visible tool catalog
// and the sandbox/approval knobs it ships with. No browser and no model call —
// these are composition facts, and the browser scenarios in this lane cover the
// surface itself.
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'
// Empty type imports carry the tools/sandboxPolicy/approval Context merges.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-permission'
import { launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'

/**
 * The catalog the shipped Web composition puts in front of the model, minus the
 * ripgrep-dependent pair below. The absences are deliberate, not incidental
 * gaps: the `cordis_*` toolset executes model-written JavaScript that no
 * sandbox row confines, `web_fetch` chooses its own request target, and
 * `mcp_*` servers spawn outside `ctx.bash`. The composition Agent Note owns the
 * rationale and its sources.
 */
const EXPECTED_TOOLS = [
  'ask_user_question',
  'bash',
  'create_goal',
  'edit',
  'exit_plan_mode',
  'get_goal',
  'list_agents',
  'ralph',
  'read',
  'send_message',
  'skill',
  'str_replace_editor',
  'subagent',
  'subagent_fork',
  'task_kill',
  'task_list',
  'task_output',
  'todo_write',
  'update_goal',
  'web_search',
  'workflow',
  'write',
]

/**
 * `glob` and `grep` come from `dsh-tool-fs-search`, which probes `command -v rg`
 * through the mounted bash executor at load and registers neither tool when
 * ripgrep is absent. That is a host dependency, not a composition decision, so the
 * pair is asserted separately — present together or absent together.
 */
const RIPGREP_TOOLS = ['glob', 'grep']

let scaffold: WebScaffold | undefined
const keylessIt = webSnapshotMode() === 'record' ? it.skip : it

class CapturingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function rpc<T>(baseUrl: string, method: string, payload: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `shipped-${method}`,
      method,
      payload,
    }),
  })
  if (!response.ok) throw new Error(`${method} failed over HTTP ${response.status}: ${await response.text()}`)
  const body = await response.json() as {
    result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
  }
  if (!body.result.ok) throw new Error(`${method} failed: ${body.result.error.code}: ${body.result.error.message}`)
  return body.result.value
}

afterEach(async () => {
  await scaffold?.close()
  scaffold = undefined
})

it('assembles the shipped Web catalog with the confined access default', async () => {
  scaffold = await launchWebScaffold()
  const names = scaffold.ctx.tools.schemas().map(schema => schema.name).sort()
  expect(names.filter(name => !RIPGREP_TOOLS.includes(name))).toEqual(EXPECTED_TOOLS)
  expect([[], RIPGREP_TOOLS]).toContainEqual(names.filter(name => RIPGREP_TOOLS.includes(name)))
  // `workspace-write` is not "the workspace and nothing else": the shared roots
  // helper always admits the temp directories too. Pinning it against an
  // explicit mode keeps the claim independent of this surface's default, and
  // keeps a future boundary test from being run inside /tmp — where an
  // "escape" write succeeds by design and reads as a sandbox failure.
  expect(writableRoots(scaffold.ctx.sandboxPolicy.resolve({ mode: 'workspace-write' }))).toEqual(
    expect.arrayContaining([canonicalPath('/tmp'), canonicalPath(tmpdir())]),
  )
  expect(scaffold.ctx.sandboxPolicy.defaultMode).toBe('workspace-write')
  expect(scaffold.ctx.approval.config.policy).toBe('ask')
  expect(scaffold.ctx.permission.defaultPreset).toBe('workspace-write')
}, 120_000)

keylessIt('carries IDE context through the shipped HTTP composition into the next model request', async () => {
  scaffold = await launchWebScaffold()
  const adapter = new CapturingAdapter()
  scaffold.ctx.llm.registerAdapter(['deepseek-official'], adapter)

  const described = await rpc<{ protocolVersion: number }>(scaffold.baseUrl, 'host.describe', {})
  const created = await rpc<{ sessionId: string }>(scaffold.baseUrl, 'session.create', {})
  await rpc<{ accepted: true }>(scaffold.baseUrl, 'session.injectContext', {
    sessionId: created.sessionId,
    content: [{ type: 'text', text: 'IDE_CONTEXT_MARKER' }],
  })

  const beforePrompt = await rpc<{
    events: { event: { type: string; data: unknown } }[]
  }>(scaffold.baseUrl, 'session.history', { sessionId: created.sessionId, maxMessages: 10 })
  expect(adapter.requests).toHaveLength(0)
  expect(described.protocolVersion).toBe(1)
  expect(beforePrompt.events.map(({ event }) => event.type)).not.toContain('turn/start')
  expect(beforePrompt.events.find(({ event }) => event.type === 'user/message')).toMatchObject({
    event: {
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: 'IDE_CONTEXT_MARKER' }],
        source: { kind: 'plugin', plugin: 'ide', rpcId: 'shipped-session.injectContext' },
      },
    },
  })
  expect({ protocolVersion: described.protocolVersion }).toMatchInlineSnapshot(`
    {
      "protocolVersion": 1,
    }
  `)

  const settled = scaffold.whenTurnSettled()
  await rpc<{ accepted: true }>(scaffold.baseUrl, 'session.prompt', {
    sessionId: created.sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: 'PROMPT_AFTER_IDE_CONTEXT' }],
  })
  await settled

  expect(adapter.requests).toHaveLength(1)
  expect(adapter.requests[0]?.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text'
      && (block.text === 'IDE_CONTEXT_MARKER' || block.text === 'PROMPT_AFTER_IDE_CONTEXT')))
    .toMatchInlineSnapshot(`
      [
        {
          "text": "IDE_CONTEXT_MARKER",
          "type": "text",
        },
        {
          "text": "PROMPT_AFTER_IDE_CONTEXT",
          "type": "text",
        },
      ]
    `)
}, 120_000)
