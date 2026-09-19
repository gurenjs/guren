import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { readAppDefaultLocale } from '../src/app-locale'
import { renderPlanFile, type RenderPlanFileOptions } from '../src/plan-render'
import { createTempWorkspace, writeWorkspaceFiles, type TempWorkspace } from './helpers'
import { loadCommentsPlan, planAppState, planPageData } from './plan-fixture'

const appEntry = (i18n: string): Record<string, string> => ({
  'src/app.ts': `import { createApp } from '@guren/core'\nexport default createApp({ routes: () => {}, ${i18n} })\n`,
})

describe('the locale plan:render opens the page in', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-plan-render-locale-')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  async function initial(planLocale: string, options: Partial<RenderPlanFileOptions> = {}): Promise<string> {
    await writeWorkspaceFiles(workspace.dir, { 'a.plan.json': JSON.stringify({ ...loadCommentsPlan(), locale: planLocale }) })
    await renderPlanFile('a.plan.json', { app: planAppState(), cwd: workspace.dir, ...options })
    return planPageData(await readFile(join(workspace.dir, 'a.plan.html'), 'utf8')).i18n.initial
  }

  test('should follow the plan', async () => {
    expect(await initial('ja', { appLocale: async () => 'en' })).toBe('ja')
  })

  test('should put --locale over the plan', async () => {
    expect(await initial('ja', { locale: 'en' })).toBe('en')
  })

  test('should ask the application only when the plan is in a language the page does not speak', async () => {
    let asked = 0
    const appLocale = async (): Promise<string> => {
      asked += 1
      return 'ja-JP'
    }

    expect(await initial('en', { appLocale })).toBe('en')
    expect(asked).toBe(0)
    expect(await initial('fr', { appLocale })).toBe('ja')
    expect(asked).toBe(1)
  })

  test('should end at en when nothing else decides', async () => {
    expect(await initial('fr', { appLocale: async () => 'de' })).toBe('en')
    expect(await initial('fr', { appLocale: async () => undefined })).toBe('en')
  })

  test('should refuse a locale the page does not ship, naming the ones it does', async () => {
    await expect(initial('en', { locale: 'fr' })).rejects.toThrow('Choose one of: en, ja.')
  })

  describe('readAppDefaultLocale', () => {
    test.each([
      ["i18n: { supported: ['ja', 'en'] }", 'ja'],
      ["i18n: { supported: ['en', 'ja'], fallback: 'ja' }", 'ja'],
      ["i18n: { supported: ['ja', 'en'] as const }", 'ja'],
      ["i18n: { supported: ['ja'] } satisfies object", 'ja'],
    ])('should read %s', async (i18n, expected) => {
      await writeWorkspaceFiles(workspace.dir, appEntry(i18n))

      expect(await readAppDefaultLocale(workspace.dir)).toBe(expected)
    })

    test.each([
      ['no i18n option', 'providers: []'],
      ['an option built elsewhere', 'i18n: i18nOptions'],
      ['a computed list', 'i18n: { supported: locales }'],
      ['a computed first entry', 'i18n: { supported: [first] }'],
      ['a fallback it cannot read', "i18n: { supported: ['ja', 'en'], fallback: preferred }"],
      ['a spread that may carry the fallback', "i18n: { supported: ['ja', 'en'], ...overrides }"],
    ])('should give no answer for %s', async (_name, i18n) => {
      await writeWorkspaceFiles(workspace.dir, appEntry(i18n))

      expect(await readAppDefaultLocale(workspace.dir)).toBeUndefined()
    })

    test('should give no answer for a directory with no app entry', async () => {
      expect(await readAppDefaultLocale(workspace.dir)).toBeUndefined()
    })
  })
})
