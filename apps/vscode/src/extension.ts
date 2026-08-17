/**
 * VS Code activation entry for the DeepSeek Harness sidebar: one managed
 * `dsh web` per window, one webview view in the Secondary Side Bar hosting the
 * dsh client stack under its narrow shell, and the postMessage↔fetch bridge
 * between them. Editor-side integrations (native approvals, diff, context
 * injection) attach here; the view itself is pure GUI hosting, and navigation
 * lives in native view title actions rather than webview pixels.
 */

import * as vscode from 'vscode'
import type { BridgeRequestMessage } from '@deepseek-ai/dsh-client-connection/client'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-interaction/types'
import { isWebviewReadyMessage } from '../webview/route-bridge.ts'
import { ActiveSessionTracker } from './active-session.ts'
import { ApiBridge } from './bridge.ts'
import { IdeContextFeed } from './context-feed.ts'
import { LoopbackApiClient, verifyHostProtocol } from './host-client.ts'
import type { EditorState, IdeDiagnostic } from './ide-context.ts'
import { NativeInteractions, type ApprovalPrompt, type NativeUi } from './interactions.ts'
import { panelHtml, WEBVIEW_DIST } from './panel.ts'
import { ServerRuntime } from './runtime.ts'
import { RuntimeLifecycle } from './runtime-lifecycle.ts'
import { ViewRouteRelay } from './view-route.ts'

let interactions: NativeInteractions | undefined
let tracker: ActiveSessionTracker | undefined
let feed: IdeContextFeed | undefined
/** Editor-event subscriptions owned by the context feed; cleared on teardown. */
let feedSubscriptions: vscode.Disposable[] = []
/** True once the native host-side layer (interactions + context feed) is running. */
let nativeStarted = false
// Generation counter for the native layer: disposeNativeLayer() bumps it, so
// a protocol probe still in flight from a torn-down generation can tell it is
// stale and must not (re)start the layer.
let nativeEpoch = 0

function nativeLayerLive(): boolean {
  return nativeStarted
}

// The clients and the bridge resolve the server origin through this getter,
// never a captured ServerRuntime instance, so a restart that swaps `runtime`
// is followed automatically without rebuilding the panel or its bridge.
function currentOrigin(): URL | undefined {
  return runtimeLifecycle?.current?.url
}

/** Lines of file text sampled around the cursor when there is no selection. */
const CURSOR_WINDOW_LINES = 24
/** Bounds for one IDE-context sample. */
const SAMPLE_LIMITS = { maxTextChars: 4000, maxDiagnostics: 20 }

/** Resolve the view's asset URLs and CSP source from the webview and extension root. */
function panelAssets(webview: vscode.Webview, extensionUri: vscode.Uri): Parameters<typeof panelHtml>[0] {
  const dist = vscode.Uri.joinPath(extensionUri, ...WEBVIEW_DIST)
  return {
    script: webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
    style: webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css')).toString(),
    cspSource: webview.cspSource,
  }
}

let runtimeLifecycle: RuntimeLifecycle<ServerRuntime> | undefined

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
    // The notification cannot be closed programmatically, so the abort signal
    // cannot dismiss an approval already on screen — a VS Code limitation. It
    // stays non-modal, so a resolved-elsewhere frame simply supersedes it and a
    // late click answers a no-longer-pending request (harmless not-pending).
    confirmApproval: async (prompt) => {
      const choice = await vscode.window.showInformationMessage(
        `DeepSeek Harness wants to run ${prompt.toolName}`,
        { detail: approvalDetail(prompt), modal: false },
        'Allow', 'Reject',
      )
      return choice === 'Allow' ? 'allowed-once' : choice === 'Reject' ? 'rejected' : 'dismissed'
    },
    askQuestions: (items, signal) => askQuestionsNatively(items, signal),
  }
}

/** Show one QuickPick that resolves to the picked labels, undefined on dismiss, or on abort. */
function pickOne(item: AskUserQuestionItem, signal: AbortSignal): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick()
    quickPick.title = item.question
    if (item.detail !== undefined) quickPick.placeholder = item.detail
    quickPick.canSelectMany = item.multiSelect ?? false
    quickPick.items = (item.options ?? []).map(option => ({
      label: option.label,
      ...option.description === undefined ? {} : { description: option.description },
    }))
    let done = false
    const settle = (value: string[] | undefined): void => {
      if (done) return
      done = true
      signal.removeEventListener('abort', onAbort)
      quickPick.dispose()
      resolve(value)
    }
    const onAbort = (): void => { settle(undefined) }
    quickPick.onDidAccept(() => { settle(quickPick.selectedItems.map(i => i.label)) })
    quickPick.onDidHide(() => { settle(undefined) })
    signal.addEventListener('abort', onAbort, { once: true })
    quickPick.show()
  })
}

/** Show one InputBox that resolves to its value, undefined on dismiss, or on abort. */
function inputOne(item: AskUserQuestionItem, signal: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve) => {
    const inputBox = vscode.window.createInputBox()
    inputBox.title = item.question
    if (item.detail !== undefined) inputBox.placeholder = item.detail
    let done = false
    const settle = (value: string | undefined): void => {
      if (done) return
      done = true
      signal.removeEventListener('abort', onAbort)
      inputBox.dispose()
      resolve(value)
    }
    const onAbort = (): void => { settle(undefined) }
    inputBox.onDidAccept(() => { settle(inputBox.value) })
    inputBox.onDidHide(() => { settle(undefined) })
    signal.addEventListener('abort', onAbort, { once: true })
    inputBox.show()
  })
}

/**
 * Drive one ask() batch through sequential QuickPicks/InputBoxes; undefined
 * (a dismiss or the request resolving elsewhere via `signal`) leaves it for
 * the webview.
 */
async function askQuestionsNatively(items: AskUserQuestionItem[], signal: AbortSignal): Promise<AskUserQuestionAnswer | undefined> {
  const answers: AskUserQuestionAnswer['answers'] = []
  for (const item of items) {
    if (signal.aborted) return undefined
    if ((item.options ?? []).length === 0) {
      const custom = await inputOne(item, signal)
      if (custom === undefined) return undefined
      answers.push({ id: item.id, selected: [], custom })
      continue
    }
    const selected = await pickOne(item, signal)
    if (selected === undefined) return undefined
    answers.push({ id: item.id, selected })
  }
  return { answers }
}

/**
 * Start the host-side native layer (approval/question prompts + IDE-context
 * feed) once, after gating on the host's protocol version. An independently
 * released extension may reach a `DSH_BIN`/PATH `dsh` of a different version;
 * on a mismatch the native layer stays off and the user is warned. The
 * webview performs the same gate before its client graph starts.
 */
async function ensureNativeLayer(output: vscode.OutputChannel): Promise<void> {
  if (nativeStarted) return
  const epoch = nativeEpoch
  const client = new LoopbackApiClient(currentOrigin)
  const check = await verifyHostProtocol(client)
  // The probe crossed an await: a teardown (restart/deactivate) may have
  // bumped the epoch, or a concurrent probe may have landed first. A stale or
  // duplicate probe must not (re)start the layer — after deactivate nobody
  // would be left to dispose it. (nativeLayerLive is a function read because
  // a concurrent probe mutates the flag across the await, which static flow
  // analysis would otherwise narrow to always-false.)
  if (epoch !== nativeEpoch || nativeLayerLive()) return
  if (!check.ok) {
    output.appendLine(`[native] protocol gate failed, native layer disabled: ${check.reason}`)
    void vscode.window.showWarningMessage(
      `DeepSeek Harness host is incompatible — ${check.reason}. Update the extension or dsh, then reload the VS Code window.`,
    )
    return
  }
  nativeStarted = true
  ensureInteractions(output)
  ensureContextFeed(output)
}

function ensureInteractions(output: vscode.OutputChannel): void {
  if (interactions !== undefined) return
  const client = new LoopbackApiClient(currentOrigin)
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

function ensureContextFeed(output: vscode.OutputChannel): void {
  if (feed !== undefined) return
  const client = new LoopbackApiClient(currentOrigin)
  const contextFeed = new IdeContextFeed({
    client,
    readEditorState: sampleActiveEditor,
    activeSession: () => tracker?.active(),
    limits: SAMPLE_LIMITS,
    log: (line) => { output.appendLine(`[ide-context] ${line}`) },
  })
  feed = contextFeed
  // The active session changing (a new chat, a running flip) is as much a
  // reason to re-inject as an editor movement: the current editor context is
  // now new to that session. Forget the old session's signature so its next
  // reading is not suppressed, and nudge the feed at the new target.
  const sessions = new ActiveSessionTracker({
    client,
    log: (line) => { output.appendLine(`[active-session] ${line}`) },
    onActiveChanged: (previous) => {
      if (previous !== undefined) contextFeed.forget(previous)
      contextFeed.nudge()
    },
  })
  tracker = sessions
  void sessions.run()
  // Editor movements nudge the debounced feed; the debounce collapses bursts.
  // onDidChangeTextDocument covers edits that change the file without moving
  // the selection (formatters, refactors, other extensions).
  feedSubscriptions = [
    vscode.window.onDidChangeActiveTextEditor(() => { contextFeed.nudge() }),
    vscode.window.onDidChangeTextEditorSelection(() => { contextFeed.nudge() }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === vscode.window.activeTextEditor?.document) contextFeed.nudge()
    }),
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

/** Tear down the whole host-side native layer (both halves live and die together). */
function disposeNativeLayer(): void {
  nativeEpoch++
  interactions?.dispose()
  interactions = undefined
  disposeContextFeed()
  nativeStarted = false
}

function createRuntime(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  onExit: () => void,
): ServerRuntime {
  const cwd = workspaceCwd()
  return new ServerRuntime({
    appDir: context.extensionUri.fsPath,
    ...cwd === undefined ? {} : { cwd },
    env: process.env,
    log: (line) => { output.appendLine(line) },
    onExit: () => {
      onExit()
      void vscode.window.showWarningMessage('dsh web exited; the panel will reconnect when it is started again.')
    },
  })
}

/** Report a genuine startup failure after the lifecycle has cleaned its runtime. */
function reportRuntimeStartError(output: vscode.OutputChannel, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  output.appendLine(`dsh web failed to start: ${message}`)
  void vscode.window.showErrorMessage(`DeepSeek Harness: dsh web failed to start — ${message}`)
}

/** Report a runtime teardown failure after extension disposal requested it. */
function reportRuntimeTeardownError(output: vscode.OutputChannel, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  output.appendLine(`dsh web failed to stop: ${message}`)
  void vscode.window.showErrorMessage(`DeepSeek Harness: dsh web failed to stop — ${message}`)
}

/** Narrow one untrusted webview message to the API bridge request vocabulary. */
function isBridgeRequestMessage(message: unknown): message is BridgeRequestMessage {
  if (typeof message !== 'object' || message === null) return false
  const type = (message as { type?: unknown }).type
  return type === 'dsh-fetch' || type === 'dsh-fetch-abort'
}

/**
 * The Secondary Side Bar view: VS Code resolves it when the container is first
 * revealed and may dispose it when the user closes it. The managed server
 * starts on the first resolve and outlives the view, so hiding the sidebar
 * never restarts the agent.
 */
function createViewProvider(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  lifecycle: RuntimeLifecycle<ServerRuntime>,
  routes: ViewRouteRelay<vscode.Webview>,
): vscode.WebviewViewProvider {
  return {
    resolveWebviewView(resolved) {
      routes.attach(resolved.webview)
      void lifecycle.start().catch((error: unknown) => { reportRuntimeStartError(output, error) })
      resolved.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
      }
      const bridge = new ApiBridge({
        origin: currentOrigin,
        post: (message) => { void resolved.webview.postMessage(message) },
      })
      resolved.webview.html = panelHtml(panelAssets(resolved.webview, context.extensionUri))
      const receiving = resolved.webview.onDidReceiveMessage((message: unknown) => {
        if (isWebviewReadyMessage(message)) {
          routes.markWebviewReady(resolved.webview)
          return
        }
        if (isBridgeRequestMessage(message)) bridge.handle(message)
      })
      resolved.onDidDispose(() => {
        receiving.dispose()
        bridge.dispose()
        routes.detach(resolved.webview)
      })
    },
  }
}

/** The view id contributed into the Secondary Side Bar container. */
export const VIEW_ID = 'dsh.sidebar'

/**
 * Register the sidebar view provider, the navigation commands, and the output
 * channel.
 * @param context - the extension context VS Code hands to activation.
 */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('DeepSeek Harness')
  const routes = new ViewRouteRelay<vscode.Webview>()
  const lifecycle = new RuntimeLifecycle<ServerRuntime>({
    create: () => createRuntime(context, output, () => { routes.markHostUnavailable() }),
    onReady: async () => {
      routes.markHostReady()
      await ensureNativeLayer(output)
    },
    onStartError: (error) => { reportRuntimeStartError(output, error) },
  })
  runtimeLifecycle = lifecycle
  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(VIEW_ID, createViewProvider(context, output, lifecycle, routes), {
      // The GUI is a long-lived session surface; re-resolving it whenever the
      // sidebar is hidden would drop composer drafts and scroll state.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // Navigation lives in native view title actions: they cost the webview no
    // pixels, which matters most in a 300-400px column.
    vscode.commands.registerCommand('dsh.showChat', () => { routes.routeTo('chat') }),
    vscode.commands.registerCommand('dsh.showSessions', () => { routes.routeTo('sessions') }),
    vscode.commands.registerCommand('dsh.focus', async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`)
    }),
    vscode.commands.registerCommand('dsh.restartServer', async () => {
      disposeNativeLayer()
      routes.markHostUnavailable()
      await lifecycle.restart()
    }),
    { dispose: () => {
      disposeNativeLayer()
      routes.markHostUnavailable()
      void lifecycle.deactivate().catch((error: unknown) => { reportRuntimeTeardownError(output, error) })
    } },
  )
}

/** Await server teardown when the extension host deactivates. */
export async function deactivate(): Promise<void> {
  disposeNativeLayer()
  const lifecycle = runtimeLifecycle
  runtimeLifecycle = undefined
  await lifecycle?.deactivate()
}
