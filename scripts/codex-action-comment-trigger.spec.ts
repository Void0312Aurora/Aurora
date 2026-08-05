import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

function commentTask(): { name: unknown; if: string; steps: unknown[] } {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, '.github/workflows/codex-action.yml'), 'utf8'))
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) throw new TypeError('codex-action workflow must define jobs')
  const job = workflow.jobs['comment-task']
  if (!isRecord(job) || typeof job.if !== 'string' || !Array.isArray(job.steps)) {
    throw new TypeError('comment-task must define an if condition and steps')
  }
  return { name: job.name, if: job.if, steps: job.steps }
}

describe('codex-action comment trigger', () => {
  it('triggers on an exact /codex slash command, not a mention', () => {
    const job = commentTask()
    expect(job.name).toBe('Codex /codex comment task')
    const condition = job.if
    expect(condition).toContain("github.event.comment.body == '/codex'")
    expect(condition).toContain("startsWith(github.event.comment.body, '/codex ')")
    // A broad substring match would re-open the duplicate-run regression the
    // slash command exists to close; both shapes are rejected.
    expect(condition).not.toContain('contains(github.event.comment.body')
    expect(condition).not.toContain('@codex')
  })

  it('preserves the actor, association, and read-only sandbox boundaries', () => {
    const job = commentTask()
    const condition = job.if
    expect(condition).toContain("github.actor == 'Void0312Aurora'")
    expect(condition).toContain('["OWNER","MEMBER","COLLABORATOR"]')

    const codexSteps = job.steps.flatMap((step) => {
      if (!isRecord(step) || typeof step.uses !== 'string' || !step.uses.startsWith('openai/codex-action@')) return []
      return [step]
    })
    expect(codexSteps[0], 'comment-task must run Codex').toMatchObject({
      with: { sandbox: 'read-only' },
    })
  })
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
