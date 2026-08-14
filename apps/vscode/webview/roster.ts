/**
 * The static plugin roster: the browser halves of every dsh client plugin
 * this webview composes, bundled at build time (the webview cannot fetch
 * bundles — its origin never reaches the server directly). The set mirrors
 * the `dshClient` rows of `apps/cli/config/web.cordis.yml` minus dev-only
 * hmr, with two substitutions for the sidebar host: the narrow shell replaces
 * the three-column one (both occupy 'root', so exactly one may load), and the
 * VS Code theme adapter plus the host route bridge join. The modules and
 * app-shell rows stay kernel-owned inside `AppWebEntry`.
 */

import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'
import * as Connection from '@deepseek-ai/dsh-client-connection/client'
import * as Runtime from '@deepseek-ai/dsh-client-runtime/client'
import * as UiTheme from '@deepseek-ai/dsh-client-ui-theme/client'
import * as Locale from '@deepseek-ai/dsh-client-locale/client'
import * as UiSidebar from '@deepseek-ai/dsh-client-ui-sidebar/client'
import * as UiSettings from '@deepseek-ai/dsh-client-ui-settings/client'
import * as UiSettingsGeneral from '@deepseek-ai/dsh-client-ui-settings-general/client'
import * as UiModels from '@deepseek-ai/dsh-client-ui-models/client'
import * as UiConversation from '@deepseek-ai/dsh-client-ui-conversation/client'
import * as UiWorkspace from '@deepseek-ai/dsh-client-ui-workspace/client'
import * as UiSlash from '@deepseek-ai/dsh-client-ui-slash/client'
import * as UiCommand from '@deepseek-ai/dsh-client-ui-command/client'
import * as UiSkill from '@deepseek-ai/dsh-client-ui-skill/client'
import * as UiSubagent from '@deepseek-ai/dsh-client-ui-subagent/client'
import * as UiGoal from '@deepseek-ai/dsh-client-ui-goal/client'
import * as UiModel from '@deepseek-ai/dsh-client-ui-model/client'
import * as UiPermission from '@deepseek-ai/dsh-client-ui-permission/client'
import * as UiPlan from '@deepseek-ai/dsh-client-ui-plan/client'
import * as UiQuestion from '@deepseek-ai/dsh-client-ui-question/client'
import * as UiTrajectory from '@deepseek-ai/dsh-client-ui-trajectory/client'
import * as DirectoryPickerBrowse from '@deepseek-ai/dsh-host-directory-picker-browse/client'
import * as VscodeTheme from './theme.ts'
import * as VscodeRoutes from './route-bridge.ts'
import * as VscodeShell from './shell/index.ts'

/** The VS Code theme adapter's boot-graph id (a webview-own module, not an npm package). */
export const VSCODE_THEME_ID = 'dsh-vscode-theme'
/** The host route bridge's boot-graph id (a webview-own module, not an npm package). */
export const VSCODE_ROUTES_ID = 'dsh-vscode-routes'
/** The sidebar shell's boot-graph id: it occupies 'root' in place of ui-layout. */
export const VSCODE_SHELL_ID = 'dsh-vscode-shell'

/** Boot-graph id → statically bundled export surface. */
export const staticPlugins: Record<string, unknown> = {
  '@deepseek-ai/dsh-client-connection': Connection,
  '@deepseek-ai/dsh-client-runtime': Runtime,
  '@deepseek-ai/dsh-client-ui-theme': UiTheme,
  '@deepseek-ai/dsh-client-locale': Locale,
  '@deepseek-ai/dsh-client-ui-sidebar': UiSidebar,
  '@deepseek-ai/dsh-client-ui-settings': UiSettings,
  '@deepseek-ai/dsh-client-ui-settings-general': UiSettingsGeneral,
  '@deepseek-ai/dsh-client-ui-models': UiModels,
  '@deepseek-ai/dsh-client-ui-conversation': UiConversation,
  '@deepseek-ai/dsh-client-ui-workspace': UiWorkspace,
  '@deepseek-ai/dsh-client-ui-slash': UiSlash,
  '@deepseek-ai/dsh-client-ui-command': UiCommand,
  '@deepseek-ai/dsh-client-ui-skill': UiSkill,
  '@deepseek-ai/dsh-client-ui-subagent': UiSubagent,
  '@deepseek-ai/dsh-client-ui-goal': UiGoal,
  '@deepseek-ai/dsh-client-ui-model': UiModel,
  '@deepseek-ai/dsh-client-ui-permission': UiPermission,
  '@deepseek-ai/dsh-client-ui-plan': UiPlan,
  '@deepseek-ai/dsh-client-ui-question': UiQuestion,
  '@deepseek-ai/dsh-client-ui-trajectory': UiTrajectory,
  '@deepseek-ai/dsh-host-directory-picker-browse': DirectoryPickerBrowse,
  [VSCODE_THEME_ID]: VscodeTheme,
  [VSCODE_ROUTES_ID]: VscodeRoutes,
  [VSCODE_SHELL_ID]: VscodeShell,
}

/**
 * Build the static boot graph for `window.__DSH_BOOT__`: one entry per
 * static plugin with placeholder transport fields (every id resolves through
 * the module system's statics table, so no url is ever fetched).
 * @returns the graph in the host-injected wire shape.
 */
export function staticBootGraph(): WebBootGraph {
  return {
    rev: 'static',
    entries: Object.keys(staticPlugins).map(id => ({ id, url: `static:${id}`, rev: 'static' })),
  }
}
