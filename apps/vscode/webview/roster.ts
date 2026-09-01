/**
 * The static browser-plugin roster for the VS Code webview. Its package rows
 * mirror the current dsh-base + dsh-web-app composition, with the Web-only HMR
 * row omitted and the wide layout row replaced by the sidebar shell below.
 * The modules package and app-shell assembly remain owned by AppWebEntry.
 */

import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'
import * as TypertRegistry from '@deepseek-ai/dsh-typert-registry/client'
import * as ApiGateway from '@deepseek-ai/dsh-api-gateway/client'
import * as SessionLogExport from '@deepseek-ai/dsh-session-log-export/client'
import * as Connection from '@deepseek-ai/dsh-client-connection/client'
import * as ApiRemotes from '@deepseek-ai/dsh-api-remotes/client'
import * as Runtime from '@deepseek-ai/dsh-client-runtime/client'
import * as CordisClientRunner from '@deepseek-ai/dsh-cordis-client-runner/client'
import * as UiTheme from '@deepseek-ai/dsh-client-ui-theme/client'
import * as Locale from '@deepseek-ai/dsh-client-locale/client'
import * as UiSidebar from '@deepseek-ai/dsh-client-ui-sidebar/client'
import * as UiSettings from '@deepseek-ai/dsh-client-ui-settings/client'
import * as UiSettingsGeneral from '@deepseek-ai/dsh-client-ui-settings-general/client'
import * as UiSettingsModels from '@deepseek-ai/dsh-client-ui-settings-models/client'
import * as UiSettingsPluginInventory from '@deepseek-ai/dsh-client-ui-settings-plugin-inventory/client'
import * as UiConversation from '@deepseek-ai/dsh-client-ui-conversation/client'
import * as UiTool from '@deepseek-ai/dsh-client-ui-tool/client'
import * as UiCordis from '@deepseek-ai/dsh-client-ui-cordis/client'
import * as UiWorkflowRun from '@deepseek-ai/dsh-client-ui-workflow-run/client'
import * as UiDeliverables from '@deepseek-ai/dsh-client-ui-deliverables/client'
import * as UiWorkspace from '@deepseek-ai/dsh-client-ui-workspace/client'
import * as UiInputTrigger from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import * as UiCommands from '@deepseek-ai/dsh-client-ui-commands/client'
import * as UiSkill from '@deepseek-ai/dsh-client-ui-skill/client'
import * as UiSubagent from '@deepseek-ai/dsh-client-ui-subagent/client'
import * as UiJobs from '@deepseek-ai/dsh-client-ui-jobs/client'
import * as UiGoal from '@deepseek-ai/dsh-client-ui-goal/client'
import * as UiMessageFeedback from '@deepseek-ai/dsh-client-ui-message-feedback/client'
import * as UiModelSelection from '@deepseek-ai/dsh-client-ui-model-selection/client'
import * as UiPermissionPresets from '@deepseek-ai/dsh-client-ui-permission-presets/client'
import * as UiAgentPreset from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import * as UiSettingsPlugins from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import * as UiPlan from '@deepseek-ai/dsh-client-ui-plan/client'
import * as UiUserQuestions from '@deepseek-ai/dsh-client-ui-user-questions/client'
import * as UiTrajectory from '@deepseek-ai/dsh-client-ui-trajectory/client'
import * as VscodeTheme from './theme.ts'
import * as VscodeRoutes from './route-bridge.ts'
import * as VscodeShell from './shell/index.ts'

/** The VS Code theme adapter's boot-graph id. */
export const VSCODE_THEME_ID = 'dsh-vscode-theme'
/** The host route bridge's boot-graph id. */
export const VSCODE_ROUTES_ID = 'dsh-vscode-routes'
/** The sidebar shell's boot-graph id. */
export const VSCODE_SHELL_ID = 'dsh-vscode-shell'

/** Boot-graph id to statically bundled plugin exports. */
export const staticPlugins: Record<string, unknown> = {
  '@deepseek-ai/dsh-typert-registry': TypertRegistry,
  '@deepseek-ai/dsh-api-gateway': ApiGateway,
  '@deepseek-ai/dsh-session-log-export': SessionLogExport,
  '@deepseek-ai/dsh-client-connection': Connection,
  '@deepseek-ai/dsh-api-remotes': ApiRemotes,
  '@deepseek-ai/dsh-client-runtime': Runtime,
  '@deepseek-ai/dsh-cordis-client-runner': CordisClientRunner,
  '@deepseek-ai/dsh-client-ui-theme': UiTheme,
  '@deepseek-ai/dsh-client-locale': Locale,
  '@deepseek-ai/dsh-client-ui-sidebar': UiSidebar,
  '@deepseek-ai/dsh-client-ui-settings': UiSettings,
  '@deepseek-ai/dsh-client-ui-settings-general': UiSettingsGeneral,
  '@deepseek-ai/dsh-client-ui-settings-models': UiSettingsModels,
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory': UiSettingsPluginInventory,
  '@deepseek-ai/dsh-client-ui-conversation': UiConversation,
  '@deepseek-ai/dsh-client-ui-tool': UiTool,
  '@deepseek-ai/dsh-client-ui-cordis': UiCordis,
  '@deepseek-ai/dsh-client-ui-workflow-run': UiWorkflowRun,
  '@deepseek-ai/dsh-client-ui-deliverables': UiDeliverables,
  '@deepseek-ai/dsh-client-ui-workspace': UiWorkspace,
  '@deepseek-ai/dsh-client-ui-input-trigger': UiInputTrigger,
  '@deepseek-ai/dsh-client-ui-commands': UiCommands,
  '@deepseek-ai/dsh-client-ui-skill': UiSkill,
  '@deepseek-ai/dsh-client-ui-subagent': UiSubagent,
  '@deepseek-ai/dsh-client-ui-jobs': UiJobs,
  '@deepseek-ai/dsh-client-ui-goal': UiGoal,
  '@deepseek-ai/dsh-client-ui-message-feedback': UiMessageFeedback,
  '@deepseek-ai/dsh-client-ui-model-selection': UiModelSelection,
  '@deepseek-ai/dsh-client-ui-permission-presets': UiPermissionPresets,
  '@deepseek-ai/dsh-client-ui-agent-preset': UiAgentPreset,
  '@deepseek-ai/dsh-client-ui-settings-plugins': UiSettingsPlugins,
  '@deepseek-ai/dsh-client-ui-plan': UiPlan,
  '@deepseek-ai/dsh-client-ui-user-questions': UiUserQuestions,
  '@deepseek-ai/dsh-client-ui-trajectory': UiTrajectory,
  [VSCODE_THEME_ID]: VscodeTheme,
  [VSCODE_ROUTES_ID]: VscodeRoutes,
  [VSCODE_SHELL_ID]: VscodeShell,
}

/**
 * Build the host-injected boot graph for the statically bundled roster.
 * Placeholder URLs cannot be fetched; the module system resolves every row
 * from the static plugin table.
 * @returns the static webview graph.
 */
export function staticBootGraph(): WebBootGraph {
  return {
    rev: 'static',
    entries: Object.keys(staticPlugins).map(id => ({ id, url: `static:${id}`, rev: 'static' })),
  }
}
