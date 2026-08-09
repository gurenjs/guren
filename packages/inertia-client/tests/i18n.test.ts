import { describe, test, expect, spyOn } from 'bun:test'
import { createTranslator, resolveTranslation, type I18nPageProps, type Translation } from '../src/i18n'
// Parity oracle: the server-side Translator this module mirrors. Test-only
// import — the shipped bundle must stay free of server code.
import { Translator, pluralizationRules } from '../../server/src/i18n'
import type { InertiaI18nProps } from '../../server/src/providers/I18nServiceProvider'

// Type-level parity: the `_i18n` prop shape must stay mutually assignable
// with the server's InertiaI18nProps, or useTranslation silently degrades.
const _serverToClient: I18nPageProps = {} as InertiaI18nProps
const _clientToServer: InertiaI18nProps = {} as I18nPageProps
void _serverToClient
void _clientToServer

const MESSAGES = {
  en: {
    messages: {
      hello: 'Hello',
      welcome: 'Welcome, :name!',
      braced: 'Hello, {name}!',
      items: 'One item|:count items',
      enOnly: 'English only',
      nested: { deep: { key: 'Deep value' } },
      empty: '',
      special: 'Total: :price[0] / {price[0]}',
      overlap: ':name / :nameLong',
      twoForms: 'one|other',
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

function translator(locale: string, fallbackLocale = 'en'): Translation {
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

  test('tc treats an empty translation as missing while t returns it', () => {
    expect(translator('en').t('messages.empty')).toBe('')
    expect(translator('en').tc('messages.empty', 2)).toBe('messages.empty')
  })

  test('keeps $ sequences in replacement values literal', () => {
    expect(translator('en').t('messages.welcome', { name: '$& $1 $$' })).toBe('Welcome, $& $1 $$!')
  })

  test('treats regex metacharacters in replacement keys literally', () => {
    expect(translator('en').t('messages.special', { 'price[0]': 42 })).toBe('Total: 42 / 42')
  })
})

describe('resolveTranslation', () => {
  test('builds a translator when the _i18n prop is present', () => {
    const translation = resolveTranslation({ locale: 'ja', fallbackLocale: 'en', messages: MESSAGES })
    expect(translation.t('messages.hello')).toBe('こんにちは')
  })

  test('echoes keys and warns once when the _i18n prop is absent', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const translation = resolveTranslation(undefined)
      expect(translation.t('messages.hello')).toBe('messages.hello')
      expect(translation.tc('messages.items', 3)).toBe('messages.items')
      expect(translation.locale).toBe('')

      resolveTranslation(undefined)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
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
    // Interpolation edge cases: $ sequences in values stay literal, regex
    // metacharacters in keys match literally, overlapping placeholder names.
    ['en', 'messages.welcome', { name: '$& $1 $$' }],
    ['en', 'messages.special', { 'price[0]': 42 }],
    ['en', 'messages.overlap', { name: 'a', nameLong: 'b' }],
    ['en', 'messages.overlap', { nameLong: 'b', name: 'a' }],
    // Empty translation: t() returns it as-is.
    ['en', 'messages.empty', undefined],
    ['ja', 'messages.empty', undefined],
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
    // Empty translation: tc() treats it as missing (unlike t()).
    ['en', 'messages.empty', 2],
    ['ja', 'messages.empty', 2],
    // Fewer forms than the rule's index: last form wins.
    ['ru', 'messages.twoForms', 5],
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

  // Sweep every locale the server's pluralization table knows (plus variants
  // exercising the primary-subtag and default paths) across a count range
  // covering the mod-10/mod-100 branches. Deriving the list from the server
  // export means a locale added on either side alone fails here.
  const PLURAL_SWEEP_MESSAGES = {
    en: { forms: '0|1|2|3|4|5' },
  }

  test.each([...Object.keys(pluralizationRules), 'en-US', 'ja-JP', 'unknown-locale'])(
    'plural rule parity across counts: %s',
    (locale) => {
      const client = createTranslator({
        locale,
        fallbackLocale: 'en',
        messages: PLURAL_SWEEP_MESSAGES,
      })
      const server = new Translator({
        locale,
        fallbackLocale: 'en',
        messages: PLURAL_SWEEP_MESSAGES,
      })

      for (let count = 0; count <= 120; count++) {
        expect(client.tc('forms', count)).toBe(server.tc('forms', count))
      }
    },
  )
})
