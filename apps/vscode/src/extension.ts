/**
 * VS Code activation entry for the DeepSeek Harness rich-UI panel: one
 * managed `dsh web` per window, one webview panel hosting the full dsh
 * client stack, and the postMessage↔fetch bridge between them. Editor-side
 * integrations for native approvals, questions, and context injection are
 * coordinated from this entry; the panel itself is pure GUI hosting.
 */

import * as vscode from 'vscode'
import type { BridgeRequestMessage } from '@deepseek-ai/dsh-client-connection/client'
import { ActiveSessionTracker } from './active-session.ts'
import { ApiBridge } from './bridge.ts'
import { IdeContextFeed } from './context-feed.ts'
import { LoopbackApiClient } from './host-client.ts'
import type { EditorState, IdeDiagnostic } from './ide-context.ts'
import { NativeInteractions } from './interactions.ts'
import { RuntimeLifecycle } from './lifecycle.ts'
import { createNativeUi } from './native-ui.ts'
import { panelHtml, WEBVIEW_DIST } from './panel.ts'
import { ServerRuntime } from './runtime.ts'

let interactions: NativeInteractions | undefined
let tracker: ActiveSessionTracker | undefined
let feed: IdeContextFeed | undefined
/** Editor-event subscriptions owned by the context feed; cleared on teardown. */
let feedSubscriptions: vscode.Disposable[] = []
/** Last valid editor reading, retained while the webview owns window focus. */
let retainedEditorState: EditorState = { diagnostics: [] }

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

let lifecycle: RuntimeLifecycle | undefined
let panel: vscode.WebviewPanel | undefined

/** Working directory for the managed server: the window's first workspace folder. */
function workspaceCwd(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
}

/** Current managed-server origin; every consumer resolves it per operation. */
function currentOrigin(): URL | undefined {
  return lifecycle?.origin()
}

/** Extract the explicit session from a well-formed bridged session.prompt call. */
function promptSessionId(message: Extract<BridgeRequestMessage, { type: 'dsh-fetch' }>): string | undefined {
  if (message.path !== '/api/session.prompt' || message.body === undefined) return undefined
  try {
    const request: unknown = JSON.parse(message.body)
    if (typeof request !== 'object' || request === null) return undefined
    const envelope = request as { type?: unknown; method?: unknown; payload?: unknown }
    if (envelope.type !== 'client-request' || envelope.method !== 'session.prompt') return undefined
    if (typeof envelope.payload !== 'object' || envelope.payload === null) return undefined
    const sessionId = (envelope.payload as { sessionId?: unknown }).sessionId
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
  } catch {
    return undefined
  }
}

function ensureInteractions(output: vscode.OutputChannel): void {
  if (interactions !== undefined) return
  const client = new LoopbackApiClient(currentOrigin)
  const native = new NativeInteractions({
    client,
    ui: createNativeUi(vscode.window),
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

/** Refresh the retained reading when VS Code currently exposes an editor. */
function retainActiveEditor(): void {
  const sampled = sampleActiveEditor()
  if (sampled.path !== undefined) {
    retainedEditorState = sampled
  } else if (panel?.active !== true) {
    retainedEditorState = { diagnostics: [] }
  }
}

/** Read the current editor, or the last valid reading while the panel has focus. */
function readEditorState(): EditorState {
  retainActiveEditor()
  return retainedEditorState
}

function ensureContextFeed(output: vscode.OutputChannel): void {
  if (feed !== undefined) return
  const client = new LoopbackApiClient(currentOrigin)
  const contextFeed = new IdeContextFeed({
    client,
    readEditorState,
    activeSession: () => tracker?.active(),
    limits: SAMPLE_LIMITS,
    log: (line) => { output.appendLine(`[ide-context] ${line}`) },
  })
  feed = contextFeed
  const sessions = new ActiveSessionTracker({
    client,
    log: (line) => { output.appendLine(`[active-session] ${line}`) },
    onActiveChanged: (previous, current) => {
      if (current === undefined && previous !== undefined) contextFeed.forget(previous)
      if (current !== undefined) {
        void contextFeed.sync().catch((error: unknown) => {
          output.appendLine(`[ide-context] immediate sample failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    },
  })
  tracker = sessions
  void sessions.run()
  // Editor movements nudge the debounced feed; the debounce collapses bursts.
  feedSubscriptions = [
    vscode.window.onDidChangeActiveTextEditor(() => { retainActiveEditor(); contextFeed.nudge() }),
    vscode.window.onDidChangeTextEditorSelection(() => { retainActiveEditor(); contextFeed.nudge() }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === vscode.window.activeTextEditor?.document) {
        retainActiveEditor()
        contextFeed.nudge()
      }
    }),
    vscode.languages.onDidChangeDiagnostics(() => { retainActiveEditor(); contextFeed.nudge() }),
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

/** Tear down both native consumers before their server generation. */
function disposeNativeLayer(): void {
  interactions?.dispose()
  interactions = undefined
  disposeContextFeed()
}

/** Build the one runtime-generation owner used by panel and restart commands. */
function ensureLifecycle(context: vscode.ExtensionContext, output: vscode.OutputChannel): RuntimeLifecycle {
  const logRuntime = (line: string): void => {
    output.appendLine(line)
    if (process.env.DSH_VSCODE_TEST_RUNTIME_TRACE === '1') console.error(`[dsh-vscode] ${line}`)
  }
  lifecycle ??= new RuntimeLifecycle({
    createRuntime: () => {
      const cwd = workspaceCwd()
      return new ServerRuntime({
        appDir: context.extensionUri.fsPath,
        appConfigPath: process.env.DSH_VSCODE_TEST_CONFIG
          ?? vscode.Uri.joinPath(context.extensionUri, 'config', 'web.cordis.yml').fsPath,
        ...cwd === undefined ? {} : { cwd },
        env: process.env,
        log: logRuntime,
        onExit: () => {
          void vscode.window.showWarningMessage('dsh web exited; the panel will reconnect when it is started again.')
        },
      })
    },
    startNative: () => {
      ensureInteractions(output)
      ensureContextFeed(output)
    },
    stopNative: disposeNativeLayer,
    onStartFailure: (error) => {
      const message = error instanceof Error ? error.message : String(error)
      logRuntime(`dsh web failed to start: ${message}`)
      void vscode.window.showErrorMessage(`DeepSeek Harness: dsh web failed to start — ${message}`)
    },
  })
  return lifecycle
}

function openPanel(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  // Capture the editor before revealing/creating the webview moves focus away
  // from it; a session-added frame can then inject this reading immediately.
  retainActiveEditor()
  const owner = ensureLifecycle(context, output)
  owner.start()
  if (panel !== undefined) {
    panel.reveal()
    return
  }

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
    origin: owner.origin,
    post: (message) => { void created.webview.postMessage(message) },
    beforeRelay: async (message) => {
      const sessionId = promptSessionId(message)
      if (sessionId !== undefined) await feed?.beforeFirstPrompt(sessionId)
    },
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
      await ensureLifecycle(context, output).restart()
      panel?.reveal()
    }),
    { dispose: () => {
      void lifecycle?.dispose()
    } },
  )
}

/** Await server teardown when the extension host deactivates. */
export async function deactivate(): Promise<void> {
  const current = lifecycle
  lifecycle = undefined
  await current?.dispose()
}
