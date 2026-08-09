import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeWorkspaceFiles } from './helpers'
import { generateTranslationTypes, readTranslationCatalogs } from '../src/i18n-types'
import { runI18nCheck, extractPlaceholders } from '../src/i18n-check'

const cleanups: Array<() => Promise<void>> = []

async function makeApp(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'guren-i18n-test-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  await writeWorkspaceFiles(dir, files)
  return dir
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

const EN_NAV = JSON.stringify({ posts: 'Posts', menu: { home: 'Home' } })
const JA_NAV = JSON.stringify({ posts: '記事一覧', menu: { home: 'ホーム' } })

describe('readTranslationCatalogs', () => {
  test('flattens nested keys with the file namespace as prefix', async () => {
    const dir = await makeApp({ 'lang/en/nav.json': EN_NAV })
    const catalogs = await readTranslationCatalogs(dir)

    expect(catalogs).toHaveLength(1)
    expect([...catalogs[0]!.entries.keys()].sort()).toEqual(['nav.menu.home', 'nav.posts'])
    expect(catalogs[0]!.entries.get('nav.posts')).toBe('Posts')
  })

  test('collects unparseable files instead of failing', async () => {
    const dir = await makeApp({
      'lang/en/nav.json': EN_NAV,
      'lang/en/broken.json': '{ not json',
    })
    const [catalog] = await readTranslationCatalogs(dir)

    expect(catalog!.invalidFiles).toEqual([join('lang', 'en', 'broken.json')])
    expect(catalog!.entries.size).toBe(2)
  })

  test('returns empty for apps without lang/', async () => {
    const dir = await makeApp({})
    expect(await readTranslationCatalogs(dir)).toEqual([])
  })
})

describe('generateTranslationTypes', () => {
  test('emits a sorted key union covering every locale plus both augmentations', async () => {
    const dir = await makeApp({
      'lang/en/nav.json': EN_NAV,
      'lang/ja/nav.json': JSON.stringify({ posts: '記事一覧', jaOnly: 'のみ' }),
    })

    const { outputPath, keyCount } = await generateTranslationTypes({ appRoot: dir })
    expect(outputPath).toBe(join(dir, '.guren/translations.gen.ts'))
    expect(keyCount).toBe(3)

    const content = await readFile(outputPath!, 'utf-8')
    expect(content).toContain("  | 'nav.jaOnly'\n  | 'nav.menu.home'\n  | 'nav.posts'")
    expect(content).toContain("declare module '@guren/core'")
    expect(content).toContain("declare module '@guren/inertia-client'")
    expect(content).toContain('interface GurenTranslationKeys')
  })

  test('emits nothing without a lang/ directory', async () => {
    const dir = await makeApp({})
    const { outputPath, keyCount } = await generateTranslationTypes({ appRoot: dir })
    expect(outputPath).toBeNull()
    expect(keyCount).toBe(0)
  })
})

describe('runI18nCheck', () => {
  test('passes a clean catalog pair', async () => {
    const dir = await makeApp({
      'lang/en/nav.json': EN_NAV,
      'lang/ja/nav.json': JA_NAV,
    })

    const results = await runI18nCheck({ cwd: dir })
    expect(results).toHaveLength(2)
    expect(results.every((result) => result.status === 'pass')).toBe(true)
  })

  test('contributes nothing for apps without lang/', async () => {
    const dir = await makeApp({})
    expect(await runI18nCheck({ cwd: dir })).toEqual([])
  })

  test('fails a locale missing keys and names them', async () => {
    const dir = await makeApp({
      'lang/en/nav.json': EN_NAV,
      'lang/ja/nav.json': JSON.stringify({ posts: '記事一覧' }),
    })

    const results = await runI18nCheck({ cwd: dir })
    const ja = results.find((result) => result.key === 'i18n-parity:ja')
    expect(ja?.status).toBe('fail')
    expect(ja?.message).toContain('nav.menu.home')

    const en = results.find((result) => result.key === 'i18n-parity:en')
    expect(en?.status).toBe('pass')
  })

  test('fails on unparseable JSON files', async () => {
    const dir = await makeApp({
      'lang/en/nav.json': EN_NAV,
      'lang/en/broken.json': '{ nope',
      'lang/ja/nav.json': JA_NAV,
    })

    const results = await runI18nCheck({ cwd: dir })
    const invalid = results.find((result) => result.key.startsWith('i18n-json:'))
    expect(invalid?.status).toBe('fail')
    expect(invalid?.message).toContain('broken.json')
  })

  test('warns when placeholders differ between locales', async () => {
    const dir = await makeApp({
      'lang/en/messages.json': JSON.stringify({ welcome: 'Welcome, :name!' }),
      'lang/ja/messages.json': JSON.stringify({ welcome: 'ようこそ！' }),
    })

    const results = await runI18nCheck({ cwd: dir })
    const mismatch = results.find((result) => result.key === 'i18n-placeholders:messages.welcome')
    expect(mismatch?.status).toBe('warn')
    expect(mismatch?.message).toContain('ja lacks :name')
  })

  test('accepts placeholder unions across plural forms', async () => {
    const dir = await makeApp({
      'lang/en/messages.json': JSON.stringify({ items: 'One item|:count items' }),
      'lang/ja/messages.json': JSON.stringify({ items: ':count個' }),
    })

    const results = await runI18nCheck({ cwd: dir })
    expect(results.find((result) => result.key.startsWith('i18n-placeholders:'))).toBeUndefined()
  })
})

describe('extractPlaceholders', () => {
  test('captures :name and {name} forms', () => {
    expect([...extractPlaceholders('Hi :name, {count} new')].sort()).toEqual(['count', 'name'])
  })

  test('ignores plain text and URLs without word placeholders', () => {
    expect(extractPlaceholders('Visit https://example.com').size).toBe(0)
  })

  test('does not treat times or numeric colons as placeholders', () => {
    expect(extractPlaceholders('Opens at 9:00').size).toBe(0)
  })
})
