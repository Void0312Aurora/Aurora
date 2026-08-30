/** Cancellable VS Code prompt adapter for native approvals and questions. */

import type * as vscode from 'vscode'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-interaction/types'
import type { ApprovalPrompt, NativeUi } from './interactions.ts'

/** VS Code window operations used by the prompt adapter. */
export type NativeUiWindow = Pick<typeof vscode.window, 'createInputBox' | 'createQuickPick'>

interface ApprovalItem extends vscode.QuickPickItem {
  outcome: 'allowed-once' | 'rejected'
}

interface QuestionItem extends vscode.QuickPickItem {
  answerKind: 'option' | 'custom' | 'skip'
}

interface QuestionPick {
  selected: string[]
  custom: boolean
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
): Promise<QuestionPick | undefined> {
  return new Promise((resolve) => {
    const picker = window.createQuickPick<QuestionItem>()
    picker.title = item.question
    if (item.detail !== undefined) picker.placeholder = item.detail
    picker.canSelectMany = item.multiSelect ?? false
    const questionItems: QuestionItem[] = [
      ...(item.options ?? []).map(option => ({
        answerKind: 'option' as const,
        label: option.label,
        ...option.description === undefined ? {} : { description: option.description },
      })),
      { answerKind: 'custom', label: 'Other…', description: 'Enter a custom answer' },
      { answerKind: 'skip', label: 'Skip', description: 'Answer without a selection' },
    ]
    picker.items = questionItems
    // A QuickPick shown from a WebviewPanel can be visible before VS Code has
    // published its first active row. Set the same default a user sees in the
    // native list so a keyboard accept has a deterministic single-select item.
    const firstQuestionItem = questionItems[0]
    if (!picker.canSelectMany && firstQuestionItem !== undefined) {
      picker.activeItems = [firstQuestionItem]
    }
    let done = false
    const subscriptions: vscode.Disposable[] = []
    const settle = (selected: QuestionPick | undefined): void => {
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
      picker.onDidAccept(() => {
        // For a single-select Quick Pick, the workbench's accept command can
        // fire with no selectedItems while the active row is already the
        // user's choice. Treat that active row as the selection; multi-select
        // remains explicit and must use selectedItems.
        const picked = picker.canSelectMany || picker.selectedItems.length > 0
          ? picker.selectedItems
          : picker.activeItems
        const skip = picked.some(selected => selected.answerKind === 'skip')
        if (skip && picked.length > 1) {
          picker.placeholder = 'Skip cannot be combined with another answer.'
          return
        }
        if (picked.length === 0) {
          picker.placeholder = 'Choose an option, Other, or Skip.'
          return
        }
        settle({
          selected: picked.filter(selected => selected.answerKind === 'option').map(selected => selected.label),
          custom: picked.some(selected => selected.answerKind === 'custom'),
        })
      }),
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
      input.onDidAccept(() => {
        const value = input.value.trim()
        if (value.length === 0) {
          input.validationMessage = 'Enter an answer or cancel.'
          return
        }
        settle(value)
      }),
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
        const picked = await pickQuestion(window, item, signal)
        if (picked === undefined) return undefined
        if (picked.custom) {
          const custom = await inputQuestion(window, item, signal)
          if (custom === undefined) return undefined
          answers.push({ id: item.id, selected: picked.selected, custom })
          continue
        }
        answers.push({ id: item.id, selected: picked.selected })
      }
      return { answers }
    },
  }
}
