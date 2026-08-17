/** Cancellation behavior of the production VS Code prompt adapter. */

import type * as vscode from 'vscode'
import { describe, expect, it, vi } from 'vitest'
import { createNativeUi, type NativeUiWindow } from '../src/native-ui.ts'

class FakeControl<T extends vscode.QuickPickItem = vscode.QuickPickItem> {
  title: string | undefined
  placeholder: string | undefined
  prompt: string | undefined
  value = ''
  canSelectMany = false
  items: readonly T[] = []
  selectedItems: readonly T[] = []
  readonly show = vi.fn()
  readonly hide = vi.fn(() => { this.fireHide() })
  readonly dispose = vi.fn()
  private readonly accept = new Set<() => void>()
  private readonly hidden = new Set<() => void>()

  onDidAccept(listener: () => void): vscode.Disposable {
    this.accept.add(listener)
    return { dispose: () => { this.accept.delete(listener) } }
  }

  onDidHide(listener: () => void): vscode.Disposable {
    this.hidden.add(listener)
    return { dispose: () => { this.hidden.delete(listener) } }
  }

  fireAccept(selected: readonly T[] = this.selectedItems): void {
    this.selectedItems = selected
    for (const listener of [...this.accept]) listener()
  }

  fireHide(): void {
    for (const listener of [...this.hidden]) listener()
  }
}

function fakeWindow() {
  const quickPicks: FakeControl[] = []
  const inputBoxes: FakeControl[] = []
  const window = {
    createQuickPick: () => {
      const control = new FakeControl()
      quickPicks.push(control)
      return control as unknown as vscode.QuickPick<vscode.QuickPickItem>
    },
    createInputBox: () => {
      const control = new FakeControl()
      inputBoxes.push(control)
      return control as unknown as vscode.InputBox
    },
  } as NativeUiWindow
  return { window, quickPicks, inputBoxes }
}

describe('createNativeUi', () => {
  it('closes an approval control when the request resolves in another client', async () => {
    const fake = fakeWindow()
    const ui = createNativeUi(fake.window)
    const abort = new AbortController()
    const result = ui.confirmApproval({ sessionId: 's1', toolName: 'bash' }, abort.signal)
    expect(fake.quickPicks[0]?.show).toHaveBeenCalledTimes(1)
    abort.abort()
    await expect(result).resolves.toBe('dismissed')
    expect(fake.quickPicks[0]?.hide).toHaveBeenCalledTimes(1)
    expect(fake.quickPicks[0]?.dispose).toHaveBeenCalledTimes(1)
  })

  it('closes an option QuickPick when the question resolves in another client', async () => {
    const fake = fakeWindow()
    const ui = createNativeUi(fake.window)
    const abort = new AbortController()
    const result = ui.askQuestions([{ id: 'q1', question: 'Choose', options: [{ label: 'A' }] }], abort.signal)
    abort.abort()
    await expect(result).resolves.toBeUndefined()
    expect(fake.quickPicks[0]?.hide).toHaveBeenCalledTimes(1)
    expect(fake.quickPicks[0]?.dispose).toHaveBeenCalledTimes(1)
  })

  it('stops a multi-question batch and closes its current InputBox on abort', async () => {
    const fake = fakeWindow()
    const ui = createNativeUi(fake.window)
    const abort = new AbortController()
    const result = ui.askQuestions([
      { id: 'q1', question: 'Choose', options: [{ label: 'A' }] },
      { id: 'q2', question: 'Explain' },
    ], abort.signal)
    fake.quickPicks[0]?.fireAccept(fake.quickPicks[0].items.slice(0, 1))
    await Promise.resolve()
    expect(fake.inputBoxes[0]?.show).toHaveBeenCalledTimes(1)
    abort.abort()
    await expect(result).resolves.toBeUndefined()
    expect(fake.inputBoxes[0]?.hide).toHaveBeenCalledTimes(1)
    expect(fake.inputBoxes[0]?.dispose).toHaveBeenCalledTimes(1)
  })
})
