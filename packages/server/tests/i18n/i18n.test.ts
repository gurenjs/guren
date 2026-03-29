import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  Translator,
  I18nManager,
  JsonLoader,
  MemoryLoader,
  pluralizationRules,
  getPluralizationRule,
  selectPluralForm,
  createI18n,
  setI18n,
  getI18n,
  t,
  tc,
} from '../../src/i18n'

describe('Pluralization', () => {
  describe('pluralizationRules', () => {
    it('returns correct form for English', () => {
      expect(pluralizationRules.en(0)).toBe(1) // plural
      expect(pluralizationRules.en(1)).toBe(0) // singular
      expect(pluralizationRules.en(2)).toBe(1) // plural
      expect(pluralizationRules.en(100)).toBe(1) // plural
    })

    it('returns correct form for French', () => {
      expect(pluralizationRules.fr(0)).toBe(0) // singular
      expect(pluralizationRules.fr(1)).toBe(0) // singular
      expect(pluralizationRules.fr(2)).toBe(1) // plural
    })

    it('returns correct form for Japanese (no plural)', () => {
      expect(pluralizationRules.ja(0)).toBe(0)
      expect(pluralizationRules.ja(1)).toBe(0)
      expect(pluralizationRules.ja(100)).toBe(0)
    })

    it('returns correct form for Russian (three forms)', () => {
      expect(pluralizationRules.ru(1)).toBe(0) // one
      expect(pluralizationRules.ru(2)).toBe(1) // few
      expect(pluralizationRules.ru(5)).toBe(2) // many
      expect(pluralizationRules.ru(11)).toBe(2) // many (special case)
      expect(pluralizationRules.ru(21)).toBe(0) // one
      expect(pluralizationRules.ru(22)).toBe(1) // few
    })
  })

  describe('getPluralizationRule', () => {
    it('returns rule for exact locale match', () => {
      const rule = getPluralizationRule('en')
      expect(rule(1)).toBe(0)
    })

    it('returns rule for language code', () => {
      const rule = getPluralizationRule('en-US')
      expect(rule(1)).toBe(0)
    })

    it('returns English rule as default', () => {
      const rule = getPluralizationRule('unknown')
      expect(rule(1)).toBe(0)
      expect(rule(2)).toBe(1)
    })
  })

  describe('selectPluralForm', () => {
    it('selects correct form for English', () => {
      const rule = pluralizationRules.en
      expect(selectPluralForm('apple|apples', 1, rule)).toBe('apple')
      expect(selectPluralForm('apple|apples', 2, rule)).toBe('apples')
      expect(selectPluralForm('apple|apples', 0, rule)).toBe('apples')
    })

    it('selects correct form for Russian', () => {
      const rule = pluralizationRules.ru
      expect(selectPluralForm('яблоко|яблока|яблок', 1, rule)).toBe('яблоко')
      expect(selectPluralForm('яблоко|яблока|яблок', 2, rule)).toBe('яблока')
      expect(selectPluralForm('яблоко|яблока|яблок', 5, rule)).toBe('яблок')
    })

    it('falls back to last form if index out of bounds', () => {
      const rule = pluralizationRules.ru
      expect(selectPluralForm('one|two', 5, rule)).toBe('two')
    })

    it('handles negative numbers', () => {
      const rule = pluralizationRules.en
      expect(selectPluralForm('item|items', -1, rule)).toBe('item')
      expect(selectPluralForm('item|items', -5, rule)).toBe('items')
    })
  })
})

describe('Translator', () => {
  let translator: Translator

  beforeEach(() => {
    translator = new Translator({
      locale: 'en',
      fallbackLocale: 'en',
      messages: {
        en: {
          greeting: 'Hello',
          welcome: 'Welcome, :name!',
          nested: {
            key: 'Nested value',
            deep: {
              key: 'Deep value',
            },
          },
          items: 'One item|:count items',
        },
        ja: {
          greeting: 'こんにちは',
          welcome: 'ようこそ、:nameさん！',
        },
      },
    })
  })

  describe('t()', () => {
    it('translates simple key', () => {
      expect(translator.t('greeting')).toBe('Hello')
    })

    it('translates with replacements', () => {
      expect(translator.t('welcome', { name: 'John' })).toBe('Welcome, John!')
    })

    it('supports nested keys', () => {
      expect(translator.t('nested.key')).toBe('Nested value')
      expect(translator.t('nested.deep.key')).toBe('Deep value')
    })

    it('returns key for missing translation', () => {
      expect(translator.t('missing.key')).toBe('missing.key')
    })

    it('uses fallback locale', () => {
      translator.setLocale('ja')
      expect(translator.t('nested.key')).toBe('Nested value') // fallback to en
    })

    it('supports {key} replacement format', () => {
      translator.addMessages('en', { format: 'Hello, {name}!' })
      expect(translator.t('format', { name: 'World' })).toBe('Hello, World!')
    })
  })

  describe('tc()', () => {
    it('translates with count', () => {
      expect(translator.tc('items', 1)).toBe('One item')
      expect(translator.tc('items', 5)).toBe('5 items')
    })

    it('includes count in replacements', () => {
      expect(translator.tc('items', 10)).toBe('10 items')
    })

    it('uses additional replacements', () => {
      translator.addMessages('en', { message: ':count :type|:count :types' })
      expect(translator.tc('message', 1, { type: 'apple', types: 'apples' })).toBe('1 apple')
      expect(translator.tc('message', 3, { type: 'apple', types: 'apples' })).toBe('3 apples')
    })
  })

  describe('has()', () => {
    it('returns true for existing key', () => {
      expect(translator.has('greeting')).toBe(true)
    })

    it('returns false for missing key', () => {
      expect(translator.has('missing')).toBe(false)
    })

    it('checks specific locale', () => {
      expect(translator.has('greeting', 'ja')).toBe(true)
      expect(translator.has('nested.key', 'ja')).toBe(false)
    })
  })

  describe('locale management', () => {
    it('gets and sets locale', () => {
      expect(translator.getLocale()).toBe('en')
      translator.setLocale('ja')
      expect(translator.getLocale()).toBe('ja')
    })

    it('translates in new locale after setLocale', () => {
      translator.setLocale('ja')
      expect(translator.t('greeting')).toBe('こんにちは')
    })

    it('gets and sets fallback locale', () => {
      expect(translator.getFallbackLocale()).toBe('en')
      translator.setFallbackLocale('ja')
      expect(translator.getFallbackLocale()).toBe('ja')
    })
  })

  describe('message management', () => {
    it('adds messages', () => {
      translator.addMessages('en', { new: 'New message' })
      expect(translator.t('new')).toBe('New message')
    })

    it('merges nested messages', () => {
      translator.addMessages('en', { nested: { another: 'Another' } })
      expect(translator.t('nested.key')).toBe('Nested value')
      expect(translator.t('nested.another')).toBe('Another')
    })

    it('gets messages for locale', () => {
      const messages = translator.getMessages('en')
      expect(messages.greeting).toBe('Hello')
    })

    it('gets available locales', () => {
      expect(translator.getAvailableLocales()).toEqual(['en', 'ja'])
    })
  })

  describe('custom missing key handler', () => {
    it('uses custom handler', () => {
      const customTranslator = new Translator({
        locale: 'en',
        messages: {},
        onMissingKey: (key) => `[Missing: ${key}]`,
      })
      expect(customTranslator.t('missing')).toBe('[Missing: missing]')
    })
  })
})

describe('MemoryLoader', () => {
  let loader: MemoryLoader

  beforeEach(() => {
    loader = new MemoryLoader({
      en: {
        messages: {
          hello: 'Hello',
        },
      },
      ja: {
        messages: {
          hello: 'こんにちは',
        },
      },
    })
  })

  it('loads messages for locale', async () => {
    const messages = await loader.load('en')
    expect(messages.messages).toEqual({ hello: 'Hello' })
  })

  it('returns empty object for unknown locale', async () => {
    const messages = await loader.load('unknown')
    expect(messages).toEqual({})
  })

  it('loads specific namespace', async () => {
    const messages = await loader.loadNamespace('en', 'messages')
    expect(messages).toEqual({ hello: 'Hello' })
  })

  it('gets available locales', async () => {
    const locales = await loader.getAvailableLocales()
    expect(locales).toEqual(['en', 'ja'])
  })

  it('adds messages', () => {
    loader.addMessages('fr', { messages: { hello: 'Bonjour' } })
    expect(loader.getAvailableLocales()).resolves.toContain('fr')
  })

  it('removes locale', () => {
    loader.removeLocale('ja')
    expect(loader.getAvailableLocales()).resolves.toEqual(['en'])
  })

  it('clears all messages', () => {
    loader.clear()
    expect(loader.getAvailableLocales()).resolves.toEqual([])
  })
})

describe('JsonLoader', () => {
  let tempDir: string
  let loader: JsonLoader

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'i18n-test-'))

    // Create translation files
    await mkdir(join(tempDir, 'en'))
    await mkdir(join(tempDir, 'ja'))

    await writeFile(
      join(tempDir, 'en', 'messages.json'),
      JSON.stringify({ hello: 'Hello', world: 'World' })
    )
    await writeFile(
      join(tempDir, 'en', 'validation.json'),
      JSON.stringify({ required: 'This field is required' })
    )
    await writeFile(
      join(tempDir, 'ja', 'messages.json'),
      JSON.stringify({ hello: 'こんにちは' })
    )

    loader = new JsonLoader(tempDir)
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true })
  })

  it('loads all translations for locale', async () => {
    const messages = await loader.load('en')
    expect(messages.messages).toEqual({ hello: 'Hello', world: 'World' })
    expect(messages.validation).toEqual({ required: 'This field is required' })
  })

  it('loads specific namespace', async () => {
    const messages = await loader.loadNamespace('en', 'messages')
    expect(messages).toEqual({ hello: 'Hello', world: 'World' })
  })

  it('returns empty object for missing locale', async () => {
    const messages = await loader.load('fr')
    expect(messages).toEqual({})
  })

  it('gets available locales', async () => {
    const locales = await loader.getAvailableLocales()
    expect(locales.sort()).toEqual(['en', 'ja'])
  })

  it('caches loaded translations', async () => {
    await loader.load('en')
    // Modify file
    await writeFile(
      join(tempDir, 'en', 'messages.json'),
      JSON.stringify({ hello: 'Hi' })
    )
    // Should return cached value
    const messages = await loader.load('en')
    expect((messages.messages as Record<string, string> | undefined)?.hello).toBe('Hello')
  })

  it('clears cache', async () => {
    await loader.load('en')
    await writeFile(
      join(tempDir, 'en', 'messages.json'),
      JSON.stringify({ hello: 'Hi' })
    )
    loader.clearCache()
    const messages = await loader.load('en')
    expect((messages.messages as Record<string, string> | undefined)?.hello).toBe('Hi')
  })

  it('disables caching', async () => {
    loader.setCaching(false)
    await loader.load('en')
    await writeFile(
      join(tempDir, 'en', 'messages.json'),
      JSON.stringify({ hello: 'Hi' })
    )
    const messages = await loader.load('en')
    expect((messages.messages as Record<string, string> | undefined)?.hello).toBe('Hi')
  })
})

describe('I18nManager', () => {
  let i18n: I18nManager

  beforeEach(() => {
    i18n = new I18nManager({
      locale: 'en',
      fallbackLocale: 'en',
      messages: {
        en: {
          messages: {
            hello: 'Hello',
            welcome: 'Welcome, :name!',
            items: 'One item|:count items',
          },
        },
        ja: {
          messages: {
            hello: 'こんにちは',
          },
        },
      },
    })
  })

  describe('translation methods', () => {
    it('translates with t()', () => {
      expect(i18n.t('messages.hello')).toBe('Hello')
    })

    it('translates with replacements', () => {
      expect(i18n.t('messages.welcome', { name: 'World' })).toBe('Welcome, World!')
    })

    it('translates with tc()', () => {
      expect(i18n.tc('messages.items', 1)).toBe('One item')
      expect(i18n.tc('messages.items', 5)).toBe('5 items')
    })

    it('checks translation existence', () => {
      expect(i18n.has('messages.hello')).toBe(true)
      expect(i18n.has('messages.missing')).toBe(false)
    })
  })

  describe('locale management', () => {
    it('gets and sets locale', () => {
      expect(i18n.getLocale()).toBe('en')
      i18n.setLocale('ja')
      expect(i18n.getLocale()).toBe('ja')
    })

    it('translates in new locale', () => {
      i18n.setLocale('ja')
      expect(i18n.t('messages.hello')).toBe('こんにちは')
    })

    it('gets and sets fallback locale', () => {
      expect(i18n.getFallbackLocale()).toBe('en')
      i18n.setFallbackLocale('ja')
      expect(i18n.getFallbackLocale()).toBe('ja')
    })

    it('gets available locales', () => {
      expect(i18n.getAvailableLocales()).toEqual(['en', 'ja'])
    })
  })

  describe('message management', () => {
    it('adds messages', () => {
      i18n.addMessages('fr', { messages: { hello: 'Bonjour' } })
      i18n.setLocale('fr')
      expect(i18n.t('messages.hello')).toBe('Bonjour')
    })

    it('gets messages', () => {
      const messages = i18n.getMessages('en')
      expect(messages.messages).toBeDefined()
    })

    it('checks if locale is loaded', () => {
      expect(i18n.isLocaleLoaded('en')).toBe(true)
      expect(i18n.isLocaleLoaded('fr')).toBe(false)
    })
  })

  describe('forLocale()', () => {
    it('creates scoped translator', () => {
      const jaTranslator = i18n.forLocale('ja')
      expect(jaTranslator.getLocale()).toBe('ja')
      expect(jaTranslator.t('messages.hello')).toBe('こんにちは')
    })
  })
})

describe('Global functions', () => {
  beforeEach(() => {
    const i18n = createI18n({
      locale: 'en',
      messages: {
        en: {
          hello: 'Hello',
          items: 'One item|:count items',
        },
      },
    })
    setI18n(i18n)
  })

  it('t() uses global manager', () => {
    expect(t('hello')).toBe('Hello')
  })

  it('tc() uses global manager', () => {
    expect(tc('items', 1)).toBe('One item')
    expect(tc('items', 5)).toBe('5 items')
  })

  it('getI18n() returns global manager', () => {
    const i18n = getI18n()
    expect(i18n.getLocale()).toBe('en')
  })
})
