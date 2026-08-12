/**
 * VS Code theme adapter: registers a `vscode` theme whose alias-layer tokens
 * reference the editor's own `--vscode-*` variables, then selects it. The
 * editor updates those variables in place when the user switches color
 * themes, so the GUI follows without re-registration; only the light↔dark
 * classification (which selects the static palette underneath the alias
 * overrides) needs the body-class observer.
 */

import type { Context } from 'cordis'
// Type-only: the ThemeService context merge (ctx.theme).
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'

/** Required services. */
export const inject = ['theme']

/**
 * Alias-layer overrides pointing into the editor's theme variables. Tokens
 * absent here keep the dsh palette of the matching color scheme — the goal
 * is that surfaces, text, and accents read as native to the editor, not a
 * 1:1 remap of every token.
 */
const VSCODE_TOKENS: Record<string, string> = {
  '--dsw-alias-bg-base': 'var(--vscode-editor-background)',
  '--dsw-alias-bg-module-platform': 'var(--vscode-sideBar-background)',
  '--dsw-alias-bg-overlay': 'var(--vscode-editorWidget-background)',
  '--dsw-alias-label-primary': 'var(--vscode-foreground)',
  '--dsw-alias-label-secondary': 'var(--vscode-descriptionForeground)',
  '--dsw-alias-label-tertiary': 'var(--vscode-descriptionForeground)',
  '--dsw-alias-label-caption': 'var(--vscode-disabledForeground)',
  '--dsw-alias-brand-primary': 'var(--vscode-button-background)',
  '--dsw-alias-button-primary-hover': 'var(--vscode-button-hoverBackground)',
  '--dsw-alias-label-primary-foreground': 'var(--vscode-button-foreground)',
  '--dsw-alias-button-info-fill': 'var(--vscode-button-background)',
  '--dsw-alias-button-info-hover': 'var(--vscode-button-hoverBackground)',
  '--dsw-alias-interactive-bg-hover': 'var(--vscode-list-hoverBackground)',
  '--dsw-alias-interactive-bg-hover-solid': 'var(--vscode-list-hoverBackground)',
  '--dsw-alias-interactive-bg-active': 'var(--vscode-list-activeSelectionBackground)',
  '--dsw-alias-markdown-inline-code': 'var(--vscode-textCodeBlock-background)',
  '--dsw-alias-markdown-code-block': 'var(--vscode-textCodeBlock-background)',
  '--dsw-alias-markdown-code-block-banner': 'var(--vscode-editorGroupHeader-tabsBackground)',
  '--dsw-alias-state-error-primary': 'var(--vscode-errorForeground)',
  '--dsw-alias-state-warn-primary': 'var(--vscode-editorWarning-foreground)',
  '--dsw-alias-tooltip-bg': 'var(--vscode-editorHoverWidget-background)',
  '--dsw-alias-toast-bg': 'var(--vscode-notifications-background)',
}

/** Whether the editor body classes currently describe a dark scheme. */
function darkScheme(): boolean {
  const classes = document.body.classList
  return classes.contains('vscode-dark') || classes.contains('vscode-high-contrast')
}

/**
 * Register the adapter theme and keep its color scheme aligned with the
 * editor. Registration is effect-owned; disposal restores the default theme
 * through the service's own reset semantics.
 * @param ctx - client cordis context carrying ctx.theme.
 */
export function apply(ctx: Context): void {
  let dispose: (() => void) | undefined
  const install = (): void => {
    dispose?.()
    dispose = ctx.theme.register({
      id: 'vscode',
      colorScheme: darkScheme() ? 'dark' : 'light',
      tokens: VSCODE_TOKENS,
    })
    ctx.theme.setTheme('vscode')
  }
  // The editor flips body classes (vscode-light/vscode-dark/…) on theme
  // switch; re-register so the static palette underneath follows the scheme.
  const observer = new MutationObserver(() => {
    const scheme = darkScheme() ? 'dark' : 'light'
    if (ctx.theme.getTheme().active.id === 'vscode' && ctx.theme.getTheme().active.colorScheme === scheme) return
    install()
  })
  ctx.effect(() => {
    install()
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    return () => {
      observer.disconnect()
      dispose?.()
    }
  }, 'dsh-vscode-theme: editor scheme adapter')
}
