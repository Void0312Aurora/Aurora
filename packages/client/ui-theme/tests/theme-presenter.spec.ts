// @vitest-environment jsdom
// ThemePresenter behavior account: root color-scheme and the palette attribute
// follow active.colorScheme only, token variables replace the previous apply's
// set, and dispose retracts everything the presenter wrote.

import { Context } from 'cordis'
import { beforeEach, describe, expect, it } from 'vitest'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleService } from '@deepseek-ai/dsh-client-locale/client'
import type { ThemeService, ThemeSnapshot } from '../src/client/index.ts'
import { apply, inject } from '../src/client/index.ts'
import { DARK_ATTRIBUTE, ThemePresenter } from '../src/client/theme-presenter.ts'

function snapshot(colorScheme: 'light' | 'dark', tokens: Record<string, string> = {}): ThemeSnapshot {
  // The presenter must key off colorScheme, not the id — keep them distinct.
  const active = { id: `${colorScheme}-test`, colorScheme, tokens }
  return { preference: colorScheme, active, themes: [active], revision: 1 }
}

beforeEach(() => {
  document.documentElement.style.removeProperty('color-scheme')
  document.body.removeAttribute(DARK_ATTRIBUTE)
  document.body.removeAttribute('style')
})

describe('ThemePresenter', () => {
  it('light scheme sets root color-scheme and leaves the dark attribute absent', () => {
    const presenter = new ThemePresenter()
    presenter.apply(snapshot('light'))
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
  })

  it('dark scheme sets root color-scheme and the attribute; switching to light clears both', () => {
    const presenter = new ThemePresenter()
    presenter.apply(snapshot('dark'))
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(true)
    presenter.apply(snapshot('light'))
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
  })

  it('applies tokens as inline variables and clears the previous set on theme change', () => {
    const presenter = new ThemePresenter()
    presenter.apply(snapshot('dark', { '--dsw-alias-bg': '#111', '--dsw-alias-fg': '#eee' }))
    expect(document.body.style.getPropertyValue('--dsw-alias-bg')).toBe('#111')
    expect(document.body.style.getPropertyValue('--dsw-alias-fg')).toBe('#eee')
    presenter.apply(snapshot('light', { '--dsw-alias-bg': '#fff' }))
    expect(document.body.style.getPropertyValue('--dsw-alias-bg')).toBe('#fff')
    // The old theme's extra variable is gone, not merged.
    expect(document.body.style.getPropertyValue('--dsw-alias-fg')).toBe('')
  })

  it('dispose removes color-scheme, the attribute, and every applied variable, sparing foreign inline styles', () => {
    document.body.style.setProperty('--foreign', 'kept')
    const presenter = new ThemePresenter()
    presenter.apply(snapshot('dark', { '--dsw-alias-bg': '#111' }))
    presenter.dispose()
    expect(document.documentElement.style.colorScheme).toBe('')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
    expect(document.body.style.getPropertyValue('--dsw-alias-bg')).toBe('')
    expect(document.body.style.getPropertyValue('--foreign')).toBe('kept')
  })
})

describe('the plugin seats the presenter itself', () => {
  // The shell occupying 'root' is replaceable (the VS Code sidebar ships its
  // own), so the palette must reach the document from this plugin's own apply.
  it('applies the initial snapshot, follows theme/change, and unwinds on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotsService).await()
    ctx.provide('locale', new LocaleService(ctx))
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    // Initial getter application: jsdom has no matchMedia, system resolves light.
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)

    const theme = ctx.get('theme') as ThemeService
    theme.setTheme('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(true)

    await fiber.dispose()
    expect(document.documentElement.style.colorScheme).toBe('')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
    // Listener is off: further theme changes no longer reach the document.
    theme.setTheme('light')
    theme.setTheme('dark')
    expect(document.documentElement.style.colorScheme).toBe('')
  })
})
