import { describe, test, expect } from 'bun:test'
import { createTranslator, type I18nPageProps } from '../src/i18n'
// Parity oracle: the server-side Translator this module mirrors. Test-only
// import — the shipped bundle must stay free of server code.
import { Translator } from '../../server/src/i18n'

const MESSAGES = {
  en: {
    messages: {
      hello: 'Hello',
      welcome: 'Welcome, :name!',
      braced: 'Hello, {name}!',
      items: 'One item|:count items',
      enOnly: 'English only',
      nested: { deep: { key: 'Deep value' } },
    },
  },
  ja: {
    messages: {
      hello: 'こんにちは',
      welcome: 'ようこそ、:nameさん！',
      items: ':count個',
    },
  },
  ru: {
    messages: {
      items: ':count товар|:count товара|:count товаров',
    },
  },
}

function translator(locale: string, fallbackLocale = 'en'): ReturnType<typeof createTranslator> {
  const props: I18nPageProps = { locale, fallbackLocale, messages: MESSAGES }
  return createTranslator(props)
}

describe('createTranslator', () => {
  test('translates keys with dot notation', () => {
    expect(translator('en').t('messages.hello')).toBe('Hello')
    expect(translator('en').t('messages.nested.deep.key')).toBe('Deep value')
  })

  test('interpolates :name and {name} replacements', () => {
    expect(translator('en').t('messages.welcome', { name: 'Guren' })).toBe('Welcome, Guren!')
    expect(translator('en').t('messages.braced', { name: 'Guren' })).toBe('Hello, Guren!')
    expect(translator('ja').t('messages.welcome', { name: 'Guren' })).toBe('ようこそ、Gurenさん！')
  })

  test('falls back to the fallback locale for missing keys', () => {
    expect(translator('ja').t('messages.enOnly')).toBe('English only')
  })

  test('echoes the key when no locale has it', () => {
    expect(translator('ja').t('messages.missing')).toBe('messages.missing')
  })

  test('pluralizes with locale rules', () => {
    expect(translator('en').tc('messages.items', 1)).toBe('One item')
    expect(translator('en').tc('messages.items', 5)).toBe('5 items')
    expect(translator('ja').tc('messages.items', 5)).toBe('5個')
  })

  test('supports three-form plural rules (ru)', () => {
    expect(translator('ru').tc('messages.items', 1)).toBe('1 товар')
    expect(translator('ru').tc('messages.items', 3)).toBe('3 товара')
    expect(translator('ru').tc('messages.items', 5)).toBe('5 товаров')
  })

  test('exposes the resolved locale', () => {
    expect(translator('ja').locale).toBe('ja')
  })
})

describe('parity with the server Translator', () => {
  const T_CASES: Array<[string, string, Record<string, string | number> | undefined]> = [
    ['en', 'messages.hello', undefined],
    ['en', 'messages.welcome', { name: 'World' }],
    ['en', 'messages.braced', { name: 'World' }],
    ['en', 'messages.nested.deep.key', undefined],
    ['ja', 'messages.hello', undefined],
    ['ja', 'messages.welcome', { name: '世界' }],
    ['ja', 'messages.enOnly', undefined],
    ['ja', 'messages.missing.entirely', undefined],
    ['ru', 'messages.enOnly', undefined],
  ]

  const TC_CASES: Array<[string, string, number]> = [
    ['en', 'messages.items', 0],
    ['en', 'messages.items', 1],
    ['en', 'messages.items', 2],
    ['en', 'messages.items', -1],
    ['ja', 'messages.items', 1],
    ['ja', 'messages.items', 7],
    ['ru', 'messages.items', 1],
    ['ru', 'messages.items', 3],
    ['ru', 'messages.items', 5],
    ['ru', 'messages.items', 11],
    ['ru', 'messages.items', 21],
    ['ru', 'messages.items', 104],
    ['en', 'messages.missing', 2],
    // Locale without its own catalog: forms come from the fallback,
    // the plural rule from the locale.
    ['de', 'messages.items', 1],
    ['fr', 'messages.items', 0],
  ]

  function serverTranslator(locale: string): Translator {
    return new Translator({ locale, fallbackLocale: 'en', messages: MESSAGES })
  }

  test.each(T_CASES)('t parity: %s %s', (locale, key, replacements) => {
    expect(translator(locale).t(key, replacements)).toBe(serverTranslator(locale).t(key, replacements))
  })

  test.each(TC_CASES)('tc parity: %s %s ×%d', (locale, key, count) => {
    expect(translator(locale).tc(key, count)).toBe(serverTranslator(locale).tc(key, count))
  })
})
