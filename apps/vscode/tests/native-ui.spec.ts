/** Cancellation behavior of the production VS Code prompt adapter. */

import type * as vscode from 'vscode'
import { describe, expect, it, vi } from 'vitest'
import { createNativeUi, type NativeUiWindow } from '../src/native-ui.ts'

class FakeControl<T extends vscode.QuickPickItem = vscode.QuickPickItem> {
  title: string | undefined
  placeholder: string | undefined
  prompt: string | undefined
  validationMessage: string | undefined
  value = ''
  canSelectMany = false
  items: readonly T[] = []
  activeItems: readonly T[] = []
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
    const other = fake.quickPicks[1]?.items.find(item => item.label === 'Other…')
    if (other === undefined) throw new Error('expected Other item')
    fake.quickPicks[1]?.fireAccept([other])
    await Promise.resolve()
    expect(fake.inputBoxes[0]?.show).toHaveBeenCalledTimes(1)
    abort.abort()
    await expect(result).resolves.toBeUndefined()
    expect(fake.inputBoxes[0]?.hide).toHaveBeenCalledTimes(1)
    expect(fake.inputBoxes[0]?.dispose).toHaveBeenCalledTimes(1)
  })

  it('returns a trimmed custom-only answer and keeps blank input open', async () => {
    const fake = fakeWindow()
    const ui = createNativeUi(fake.window)
    const result = ui.askQuestions([{ id: 'q1', question: 'Choose', options: [{ label: 'A' }] }], new AbortController().signal)
    const other = fake.quickPicks[0]?.items.find(item => item.label === 'Other…')
    if (other === undefined) throw new Error('expected Other item')
    fake.quickPicks[0]?.fireAccept([other])
    await Promise.resolve()

    const input = fake.inputBoxes[0]
    if (input === undefined) throw new Error('expected custom input')
    input.value = '   '
    input.fireAccept()
    expect(input.validationMessage).toMatch(/Enter an answer/)
    expect(input.hide).not.toHaveBeenCalled()
    input.value = '  custom answer  '
    input.fireAccept()
    await expect(result).resolves.toEqual({ answers: [{ id: 'q1', selected: [], custom: 'custom answer' }] })
  })

  it('preserves selected options alongside a multi-select custom answer', async () => {
    const fake = fakeWindow()
    const ui = createNativeUi(fake.window)
    const result = ui.askQuestions([{
      id: 'q1',
      question: 'Choose',
      multiSelect: true,
      options: [{ label: 'A' }, { label: 'B' }],
    }], new AbortController().signal)
    const picker = fake.quickPicks[0]
    const option = picker?.items.find(item => item.label === 'A')
    const other = picker?.items.find(item => item.label === 'Other…')
    if (picker === undefined || option === undefined || other === undefined) throw new Error('expected option and Other items')
    picker.fireAccept([option, other])
    await Promise.resolve()
    const input = fake.inputBoxes[0]
    if (input === undefined) throw new Error('expected custom input')
    input.value = 'C'
    input.fireAccept()
    await expect(result).resolves.toEqual({ answers: [{ id: 'q1', selected: ['A'], custom: 'C' }] })
  })

  it('returns selected-only and explicit skip answer shapes', async () => {
    const fake = fakeWindow()
    const ui = createNativeUi(fake.window)
    const result = ui.askQuestions([
      { id: 'q1', question: 'Choose', options: [{ label: 'A' }] },
      { id: 'q2', question: 'Optional detail' },
    ], new AbortController().signal)
    const option = fake.quickPicks[0]?.items.find(item => item.label === 'A')
    if (option === undefined) throw new Error('expected option')
    fake.quickPicks[0]?.fireAccept([option])
    await Promise.resolve()
    const skip = fake.quickPicks[1]?.items.find(item => item.label === 'Skip')
    if (skip === undefined) throw new Error('expected Skip item')
    fake.quickPicks[1]?.fireAccept([skip])
    await expect(result).resolves.toEqual({ answers: [
      { id: 'q1', selected: ['A'] },
      { id: 'q2', selected: [] },
    ] })
  })

  it('uses the active row when a single-select accept has no selectedItems', async () => {
    const fake = fakeWindow()
    const ui = createNativeUi(fake.window)
    const result = ui.askQuestions([{ id: 'q1', question: 'Choose', options: [{ label: 'A' }] }], new AbortController().signal)
    const picker = fake.quickPicks[0]
    const option = picker?.items.find(item => item.label === 'A')
    if (picker === undefined || option === undefined) throw new Error('expected option')
    picker.activeItems = [option]
    picker.fireAccept()
    await expect(result).resolves.toEqual({ answers: [{ id: 'q1', selected: ['A'] }] })
  })

  it('supports multi selected-only and multi custom-only answers in order', async () => {
    const fake = fakeWindow()
    const ui = createNativeUi(fake.window)
    const result = ui.askQuestions([
      { id: 'q1', question: 'Select', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
      { id: 'q2', question: 'Customize', multiSelect: true, options: [{ label: 'A' }] },
    ], new AbortController().signal)
    fake.quickPicks[0]?.fireAccept(fake.quickPicks[0].items.filter(item => item.label === 'A' || item.label === 'B'))
    await Promise.resolve()
    const other = fake.quickPicks[1]?.items.find(item => item.label === 'Other…')
    if (other === undefined) throw new Error('expected Other item')
    fake.quickPicks[1]?.fireAccept([other])
    await Promise.resolve()
    const input = fake.inputBoxes[0]
    if (input === undefined) throw new Error('expected custom input')
    input.value = 'C'
    input.fireAccept()
    await expect(result).resolves.toEqual({ answers: [
      { id: 'q1', selected: ['A', 'B'] },
      { id: 'q2', selected: [], custom: 'C' },
    ] })
  })
})
