import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { publishLanguageFiles, makeLanguage, listLocales } from '../src/lang'

describe('lang', () => {
  const testDir = resolve(import.meta.dir, '.test-lang')
  const langPath = join(testDir, 'lang')

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true })
    }
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true })
    }
  })

  describe('publishLanguageFiles', () => {
    test('creates default language files', () => {
      const files = publishLanguageFiles({ appRoot: testDir })

      expect(files.length).toBeGreaterThan(0)
      expect(existsSync(join(langPath, 'en'))).toBe(true)
      expect(existsSync(join(langPath, 'en', 'messages.json'))).toBe(true)
      expect(existsSync(join(langPath, 'en', 'validation.json'))).toBe(true)
      expect(existsSync(join(langPath, 'en', 'auth.json'))).toBe(true)
    })

    test('creates valid JSON files', () => {
      publishLanguageFiles({ appRoot: testDir })

      const messagesPath = join(langPath, 'en', 'messages.json')
      const content = readFileSync(messagesPath, 'utf-8')
      const parsed = JSON.parse(content)

      expect(parsed.welcome).toBeDefined()
      expect(parsed.greeting).toBeDefined()
    })

    test('does not overwrite existing files without force', () => {
      publishLanguageFiles({ appRoot: testDir })

      const files = publishLanguageFiles({ appRoot: testDir })

      expect(files.length).toBe(0)
    })

    test('overwrites existing files with force', () => {
      publishLanguageFiles({ appRoot: testDir })

      const files = publishLanguageFiles({ appRoot: testDir, force: true })

      expect(files.length).toBeGreaterThan(0)
    })

    test('respects custom path', () => {
      const customPath = 'resources/lang'
      publishLanguageFiles({ appRoot: testDir, path: customPath })

      expect(existsSync(join(testDir, customPath, 'en'))).toBe(true)
    })
  })

  describe('makeLanguage', () => {
    test('creates new locale with empty templates', () => {
      const files = makeLanguage('ja', { appRoot: testDir })

      expect(files.length).toBeGreaterThan(0)
      expect(existsSync(join(langPath, 'ja'))).toBe(true)
      expect(existsSync(join(langPath, 'ja', 'messages.json'))).toBe(true)
    })

    test('copies structure from existing locale', () => {
      publishLanguageFiles({ appRoot: testDir })

      const files = makeLanguage('es', { appRoot: testDir, from: 'en' })

      expect(files.length).toBeGreaterThan(0)
      expect(existsSync(join(langPath, 'es', 'messages.json'))).toBe(true)
      expect(existsSync(join(langPath, 'es', 'validation.json'))).toBe(true)
    })

    test('rejects invalid locale format', () => {
      const files = makeLanguage('invalid-locale-format', { appRoot: testDir })

      expect(files.length).toBe(0)
    })

    test('accepts valid locale formats', () => {
      let files = makeLanguage('ja', { appRoot: testDir })
      expect(files.length).toBeGreaterThan(0)

      files = makeLanguage('pt-BR', { appRoot: testDir })
      expect(files.length).toBeGreaterThan(0)
    })

    test('does not overwrite existing locale without force', () => {
      makeLanguage('ja', { appRoot: testDir })

      const files = makeLanguage('ja', { appRoot: testDir })

      expect(files.length).toBe(0)
    })

    test('overwrites existing locale with force', () => {
      makeLanguage('ja', { appRoot: testDir })

      const files = makeLanguage('ja', { appRoot: testDir, force: true })

      expect(files.length).toBeGreaterThan(0)
    })
  })

  describe('listLocales', () => {
    test('returns empty array when no locales exist', () => {
      const locales = listLocales({ appRoot: testDir })

      expect(locales).toEqual([])
    })

    test('returns list of available locales', () => {
      publishLanguageFiles({ appRoot: testDir })
      makeLanguage('ja', { appRoot: testDir })
      makeLanguage('es', { appRoot: testDir })

      const locales = listLocales({ appRoot: testDir })

      expect(locales).toContain('en')
      expect(locales).toContain('ja')
      expect(locales).toContain('es')
    })

    test('returns sorted locales', () => {
      publishLanguageFiles({ appRoot: testDir })
      makeLanguage('ja', { appRoot: testDir })
      makeLanguage('es', { appRoot: testDir })
      makeLanguage('de', { appRoot: testDir })

      const locales = listLocales({ appRoot: testDir })

      expect(locales).toEqual(['de', 'en', 'es', 'ja'])
    })
  })
})
