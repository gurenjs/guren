import { describe, test, expect, afterEach } from 'bun:test'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
// (rm is reused by the stale-file test)
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CAN_DENY_FILE_READS, writeWorkspaceFiles } from './helpers'
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

const INERTIA_PACKAGE_JSON = JSON.stringify({
  name: 'app',
  dependencies: { '@guren/inertia-client': '^2.0.0' },
})

describe('generateTranslationTypes', () => {
  test('emits a sorted key union covering every locale plus both augmentations', async () => {
    const dir = await makeApp({
      'package.json': INERTIA_PACKAGE_JSON,
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

  test('omits the client augmentation when @guren/inertia-client is not a dependency', async () => {
    const dir = await makeApp({
      'package.json': JSON.stringify({ name: 'api-app', dependencies: { '@guren/core': '^2.0.0' } }),
      'lang/en/nav.json': EN_NAV,
    })

    const { outputPath } = await generateTranslationTypes({ appRoot: dir })
    const content = await readFile(outputPath!, 'utf-8')
    expect(content).toContain("declare module '@guren/core'")
    expect(content).not.toContain('@guren/inertia-client')
  })

  // The augmentation is optional output, so a manifest codegen cannot read has
  // to degrade to plain string keys — never abort the run. An earlier refactor
  // onto the shared dependency probe let an EACCES propagate out of here.
  test.skipIf(!CAN_DENY_FILE_READS)('still emits keys when package.json cannot be read', async () => {
    const dir = await makeApp({
      'package.json': INERTIA_PACKAGE_JSON,
      'lang/en/nav.json': EN_NAV,
    })
    await chmod(join(dir, 'package.json'), 0o000)

    try {
      const { outputPath } = await generateTranslationTypes({ appRoot: dir })
      const content = await readFile(outputPath!, 'utf-8')
      expect(content).toContain("declare module '@guren/core'")
      expect(content).not.toContain("declare module '@guren/inertia-client'")
    } finally {
      await chmod(join(dir, 'package.json'), 0o644)
    }
  })

  test('emits nothing without a lang/ directory', async () => {
    const dir = await makeApp({})
    const { outputPath, keyCount } = await generateTranslationTypes({ appRoot: dir })
    expect(outputPath).toBeNull()
    expect(keyCount).toBe(0)
  })

  test('removes a stale generated file once lang/ disappears', async () => {
    const dir = await makeApp({
      'package.json': INERTIA_PACKAGE_JSON,
      'lang/en/nav.json': EN_NAV,
    })

    const { outputPath } = await generateTranslationTypes({ appRoot: dir })
    expect(outputPath).not.toBeNull()

    await rm(join(dir, 'lang'), { recursive: true })
    const rerun = await generateTranslationTypes({ appRoot: dir })
    expect(rerun.outputPath).toBeNull()
    await expect(readFile(join(dir, '.guren/translations.gen.ts'), 'utf-8')).rejects.toThrow()
  })

  test('collects array entries as index keys, matching runtime lookup', async () => {
    const dir = await makeApp({
      'package.json': INERTIA_PACKAGE_JSON,
      'lang/en/messages.json': JSON.stringify({ steps: ['First', 'Second'] }),
    })

    const { outputPath } = await generateTranslationTypes({ appRoot: dir })
    const content = await readFile(outputPath!, 'utf-8')
    expect(content).toContain("'messages.steps.0'")
    expect(content).toContain("'messages.steps.1'")
  })

  test('excludes runtime-unreachable dotted keys from the union', async () => {
    const dir = await makeApp({
      'package.json': INERTIA_PACKAGE_JSON,
      'lang/en/messages.json': JSON.stringify({ 'a.b': 'literal dot', ok: 'fine' }),
      'lang/en/dotted.name.json': JSON.stringify({ key: 'unreachable namespace' }),
    })

    const { outputPath, keyCount } = await generateTranslationTypes({ appRoot: dir })
    const content = await readFile(outputPath!, 'utf-8')
    expect(keyCount).toBe(1)
    expect(content).toContain("'messages.ok'")
    expect(content).not.toContain('a.b')
    expect(content).not.toContain('dotted')
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

  test('fails runtime-unreachable dotted keys', async () => {
    const dir = await makeApp({
      'lang/en/messages.json': JSON.stringify({ 'a.b': 'dot', ok: 'fine' }),
      'lang/ja/messages.json': JSON.stringify({ ok: '大丈夫' }),
    })

    const results = await runI18nCheck({ cwd: dir })
    const unreachable = results.find((result) => result.key === 'i18n-unreachable:messages.a.b')
    expect(unreachable?.status).toBe('fail')
    expect(unreachable?.message).toContain('en')
  })

  test('warns when locale directories hold no resolvable keys', async () => {
    const dir = await makeApp({
      'lang/en/messages.json': JSON.stringify({}),
      'lang/ja/messages.json': JSON.stringify({}),
    })

    const results = await runI18nCheck({ cwd: dir })
    expect(results).toHaveLength(1)
    expect(results[0]!.key).toBe('i18n-empty')
    expect(results[0]!.status).toBe('warn')
  })

  test('compares unicode and dashed placeholders across locales', async () => {
    const dir = await makeApp({
      'lang/en/messages.json': JSON.stringify({ hello: 'Hi {user-name}, {名前}' }),
      'lang/ja/messages.json': JSON.stringify({ hello: '{user-name}さん' }),
    })

    const results = await runI18nCheck({ cwd: dir })
    const mismatch = results.find((result) => result.key === 'i18n-placeholders:messages.hello')
    expect(mismatch?.status).toBe('warn')
    expect(mismatch?.message).toContain('ja lacks :名前')
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
