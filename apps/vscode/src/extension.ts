/**
 * VS Code activation entry for the DeepSeek Harness rich-UI panel: one
 * managed `dsh web` per window, one webview panel hosting the full dsh
 * client stack, and the postMessage↔fetch bridge between them. Editor-side
 * integrations (native approvals, diff, context injection) attach here as
 * they land; the panel itself is pure GUI hosting.
 */

import * as vscode from 'vscode'
import type { BridgeRequestMessage } from '@deepseek-ai/dsh-client-connection/client'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-interaction/types'
import { ActiveSessionTracker } from './active-session.ts'
import { ApiBridge } from './bridge.ts'
import { IdeContextFeed } from './context-feed.ts'
import { LoopbackApiClient } from './host-client.ts'
import type { EditorState, IdeDiagnostic } from './ide-context.ts'
import { NativeInteractions, type ApprovalPrompt, type NativeUi } from './interactions.ts'
import { panelHtml, WEBVIEW_DIST } from './panel.ts'
import { ServerRuntime } from './runtime.ts'

let interactions: NativeInteractions | undefined
let tracker: ActiveSessionTracker | undefined
let feed: IdeContextFeed | undefined
/** Editor-event subscriptions owned by the context feed; cleared on teardown. */
let feedSubscriptions: vscode.Disposable[] = []

/** Lines of file text sampled around the cursor when there is no selection. */
const CURSOR_WINDOW_LINES = 24
/** Bounds for one IDE-context sample. */
const SAMPLE_LIMITS = { maxTextChars: 4000, maxDiagnostics: 20 }

/** Resolve the panel's asset URLs and CSP source from the webview and extension root. */
function panelAssets(webview: vscode.Webview, extensionUri: vscode.Uri): Parameters<typeof panelHtml>[0] {
  const dist = vscode.Uri.joinPath(extensionUri, ...WEBVIEW_DIST)
  return {
    script: webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
    style: webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css')).toString(),
    cspSource: webview.cspSource,
  }
}

let runtime: ServerRuntime | undefined
let panel: vscode.WebviewPanel | undefined

/** Working directory for the managed server: the window's first workspace folder. */
function workspaceCwd(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
}

/** Render a cached tool call as a one-line "what this will do" hint for an approval. */
function approvalDetail(prompt: ApprovalPrompt): string {
  const call = prompt.call
  const what = call === undefined ? prompt.toolName : call.title
  return prompt.reason === undefined ? what : `${what}\n\n${prompt.reason}`
}

/** The vscode-backed native prompt surfaces (non-modal notifications + QuickPick). */
function nativeUi(): NativeUi {
  return {
    confirmApproval: async (prompt) => {
      // Non-modal: a resolved-elsewhere frame simply supersedes it, and a late
      // click answers a no-longer-pending request (harmless not-pending receipt).
      const choice = await vscode.window.showInformationMessage(
        `DeepSeek Harness wants to run ${prompt.toolName}`,
        { detail: approvalDetail(prompt), modal: false },
        'Allow', 'Reject',
      )
      return choice === 'Allow' ? 'allowed-once' : choice === 'Reject' ? 'rejected' : 'dismissed'
    },
    askQuestions: async items => askQuestionsNatively(items),
  }
}

/** Drive one ask() batch through sequential QuickPicks; undefined leaves it for the webview. */
async function askQuestionsNatively(items: AskUserQuestionItem[]): Promise<AskUserQuestionAnswer | undefined> {
  const answers: AskUserQuestionAnswer['answers'] = []
  for (const item of items) {
    const options = item.options ?? []
    if (options.length === 0) {
      // A free-text question: an input box carries the custom answer.
      const custom = await vscode.window.showInputBox({
        prompt: item.question,
        ...item.detail === undefined ? {} : { placeHolder: item.detail },
      })
      if (custom === undefined) return undefined
      answers.push({ id: item.id, selected: [], custom })
      continue
    }
    const picked = await vscode.window.showQuickPick(
      options.map(option => option.label),
      { title: item.question, canPickMany: item.multiSelect ?? false, ...item.detail === undefined ? {} : { placeHolder: item.detail } },
    )
    if (picked === undefined) return undefined
    answers.push({ id: item.id, selected: Array.isArray(picked) ? picked : [picked] })
  }
  return { answers }
}

function ensureInteractions(server: ServerRuntime, output: vscode.OutputChannel): void {
  if (interactions !== undefined) return
  const client = new LoopbackApiClient(() => server.url)
  const native = new NativeInteractions({
    client,
    ui: nativeUi(),
    log: (line) => { output.appendLine(`[native] ${line}`) },
  })
  interactions = native
  void native.run()
}

/** Read the active editor into the plain state shape the sampler consumes. */
function sampleActiveEditor(): EditorState {
  const editor = vscode.window.activeTextEditor
  if (editor === undefined) return { diagnostics: [] }
  const document = editor.document
  const path = vscode.workspace.asRelativePath(document.uri, false)
  const languageId = document.languageId
  const selection = editor.selection
  const diagnostics: IdeDiagnostic[] = vscode.languages.getDiagnostics(document.uri)
    .filter(d => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning)
    .map(d => ({
      severity: d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
      line: d.range.start.line + 1,
      message: d.message,
    }))
  if (!selection.isEmpty) {
    return {
      path,
      languageId,
      selection: document.getText(selection),
      range: { start: selection.start.line + 1, end: selection.end.line + 1 },
      diagnostics,
    }
  }
  // No selection: a bounded window around the cursor.
  const cursor = selection.active.line
  const start = Math.max(0, cursor - CURSOR_WINDOW_LINES)
  const end = Math.min(document.lineCount - 1, cursor + CURSOR_WINDOW_LINES)
  const window = document.getText(new vscode.Range(start, 0, end, document.lineAt(end).text.length))
  return {
    path,
    languageId,
    range: { start: start + 1, end: end + 1 },
    window,
    diagnostics,
  }
}

function ensureContextFeed(server: ServerRuntime, output: vscode.OutputChannel): void {
  if (feed !== undefined) return
  const client = new LoopbackApiClient(() => server.url)
  const sessions = new ActiveSessionTracker({ client, log: (line) => { output.appendLine(`[active-session] ${line}`) } })
  tracker = sessions
  void sessions.run()
  const contextFeed = new IdeContextFeed({
    client,
    readEditorState: sampleActiveEditor,
    activeSession: () => sessions.active(),
    limits: SAMPLE_LIMITS,
    log: (line) => { output.appendLine(`[ide-context] ${line}`) },
  })
  feed = contextFeed
  // Editor movements nudge the debounced feed; the debounce collapses bursts.
  feedSubscriptions = [
    vscode.window.onDidChangeActiveTextEditor(() => { contextFeed.nudge() }),
    vscode.window.onDidChangeTextEditorSelection(() => { contextFeed.nudge() }),
    vscode.languages.onDidChangeDiagnostics(() => { contextFeed.nudge() }),
  ]
}

/** Tear down the context feed and active-session tracker (server restart / deactivate). */
function disposeContextFeed(): void {
  for (const subscription of feedSubscriptions) subscription.dispose()
  feedSubscriptions = []
  feed?.dispose()
  feed = undefined
  tracker?.dispose()
  tracker = undefined
}

function ensureRuntime(context: vscode.ExtensionContext, output: vscode.OutputChannel): ServerRuntime {
  const cwd = workspaceCwd()
  runtime ??= new ServerRuntime({
    appDir: context.extensionUri.fsPath,
    ...cwd === undefined ? {} : { cwd },
    env: process.env,
    log: (line) => { output.appendLine(line) },
    onExit: () => {
      void vscode.window.showWarningMessage('dsh web exited; the panel will reconnect when it is started again.')
    },
  })
  return runtime
}

function openPanel(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  if (panel !== undefined) {
    panel.reveal()
    return
  }
  const server = ensureRuntime(context, output)
  server.start().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    output.appendLine(`dsh web failed to start: ${message}`)
    void vscode.window.showErrorMessage(`DeepSeek Harness: dsh web failed to start — ${message}`)
  })
  ensureInteractions(server, output)
  ensureContextFeed(server, output)

  const created = vscode.window.createWebviewPanel(
    'dshPanel',
    'DeepSeek Harness',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      // The GUI is a long-lived session surface; recreating it on tab switch
      // would drop composer drafts and scroll state.
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
    },
  )
  panel = created
  const bridge = new ApiBridge({
    origin: () => server.url,
    post: (message) => { void created.webview.postMessage(message) },
  })
  created.webview.html = panelHtml(panelAssets(created.webview, context.extensionUri))
  const receiving = created.webview.onDidReceiveMessage((message: BridgeRequestMessage) => {
    bridge.handle(message)
  })
  created.onDidDispose(() => {
    receiving.dispose()
    bridge.dispose()
    if (panel === created) panel = undefined
  })
}

/**
 * Register the panel command and the output channel.
 * @param context - the extension context VS Code hands to activation.
 */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('DeepSeek Harness')
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('dsh.openPanel', () => { openPanel(context, output) }),
    vscode.commands.registerCommand('dsh.restartServer', async () => {
      interactions?.dispose()
      interactions = undefined
      disposeContextFeed()
      await runtime?.dispose()
      runtime = undefined
      openPanel(context, output)
    }),
    { dispose: () => {
      interactions?.dispose()
      disposeContextFeed()
      void runtime?.dispose()
    } },
  )
}

/** Await server teardown when the extension host deactivates. */
export async function deactivate(): Promise<void> {
  interactions?.dispose()
  interactions = undefined
  disposeContextFeed()
  const current = runtime
  runtime = undefined
  await current?.dispose()
}
