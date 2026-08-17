/** Cancellable VS Code prompt adapter for native approvals and questions. */

import type * as vscode from 'vscode'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-interaction/types'
import type { ApprovalPrompt, NativeUi } from './interactions.ts'

/** VS Code window operations used by the prompt adapter. */
export type NativeUiWindow = Pick<typeof vscode.window, 'createInputBox' | 'createQuickPick'>

interface ApprovalItem extends vscode.QuickPickItem {
  outcome: 'allowed-once' | 'rejected'
}

/** Render a cached tool call as the approval prompt's operation detail. */
function approvalDetail(prompt: ApprovalPrompt): string {
  const call = prompt.call
  const what = call === undefined ? prompt.toolName : call.title
  return prompt.reason === undefined ? what : `${what}: ${prompt.reason}`
}

/** Present one cancellable approval QuickPick. */
function confirmApproval(
  window: NativeUiWindow,
  prompt: ApprovalPrompt,
  signal: AbortSignal,
): Promise<'allowed-once' | 'rejected' | 'dismissed'> {
  return new Promise((resolve) => {
    const picker = window.createQuickPick<ApprovalItem>()
    picker.title = `DeepSeek Harness wants to run ${prompt.toolName}`
    picker.placeholder = approvalDetail(prompt)
    picker.items = [
      { label: 'Allow once', description: 'Run this operation once', outcome: 'allowed-once' },
      { label: 'Reject', description: 'Do not run this operation', outcome: 'rejected' },
    ]
    let done = false
    const subscriptions: vscode.Disposable[] = []
    const settle = (outcome: 'allowed-once' | 'rejected' | 'dismissed'): void => {
      if (done) return
      done = true
      signal.removeEventListener('abort', onAbort)
      for (const subscription of subscriptions) subscription.dispose()
      picker.hide()
      picker.dispose()
      resolve(outcome)
    }
    const onAbort = (): void => { settle('dismissed') }
    subscriptions.push(
      picker.onDidAccept(() => { settle(picker.selectedItems[0]?.outcome ?? 'dismissed') }),
      picker.onDidHide(() => { settle('dismissed') }),
    )
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    else picker.show()
  })
}

/** Present one cancellable option question. */
function pickQuestion(
  window: NativeUiWindow,
  item: AskUserQuestionItem,
  signal: AbortSignal,
): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    const picker = window.createQuickPick()
    picker.title = item.question
    if (item.detail !== undefined) picker.placeholder = item.detail
    picker.canSelectMany = item.multiSelect ?? false
    picker.items = (item.options ?? []).map(option => ({
      label: option.label,
      ...option.description === undefined ? {} : { description: option.description },
    }))
    let done = false
    const subscriptions: vscode.Disposable[] = []
    const settle = (selected: string[] | undefined): void => {
      if (done) return
      done = true
      signal.removeEventListener('abort', onAbort)
      for (const subscription of subscriptions) subscription.dispose()
      picker.hide()
      picker.dispose()
      resolve(selected)
    }
    const onAbort = (): void => { settle(undefined) }
    subscriptions.push(
      picker.onDidAccept(() => { settle(picker.selectedItems.map(selected => selected.label)) }),
      picker.onDidHide(() => { settle(undefined) }),
    )
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    else picker.show()
  })
}

/** Present one cancellable free-text question. */
function inputQuestion(
  window: NativeUiWindow,
  item: AskUserQuestionItem,
  signal: AbortSignal,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const input = window.createInputBox()
    input.title = item.question
    if (item.detail !== undefined) input.prompt = item.detail
    let done = false
    const subscriptions: vscode.Disposable[] = []
    const settle = (value: string | undefined): void => {
      if (done) return
      done = true
      signal.removeEventListener('abort', onAbort)
      for (const subscription of subscriptions) subscription.dispose()
      input.hide()
      input.dispose()
      resolve(value)
    }
    const onAbort = (): void => { settle(undefined) }
    subscriptions.push(
      input.onDidAccept(() => { settle(input.value) }),
      input.onDidHide(() => { settle(undefined) }),
    )
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    else input.show()
  })
}

/** Build the editor-native interaction adapter over cancellable VS Code controls. */
export function createNativeUi(window: NativeUiWindow): NativeUi {
  return {
    confirmApproval: (prompt, signal) => confirmApproval(window, prompt, signal),
    askQuestions: async (items, signal) => {
      const answers: AskUserQuestionAnswer['answers'] = []
      for (const item of items) {
        if (signal.aborted) return undefined
        if ((item.options ?? []).length === 0) {
          const custom = await inputQuestion(window, item, signal)
          if (custom === undefined) return undefined
          answers.push({ id: item.id, selected: [], custom })
          continue
        }
        const selected = await pickQuestion(window, item, signal)
        if (selected === undefined) return undefined
        answers.push({ id: item.id, selected })
      }
      return { answers }
    },
  }
}
