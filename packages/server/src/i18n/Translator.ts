import type {
  TranslationMessages,
  ReplacementValues,
  TranslatorOptions,
  PluralizationRule,
} from './types'
import { getPluralizationRule, selectPluralForm } from './pluralization'

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g

/**
 * Translator class for handling translations.
 */
export class Translator {
  private locale: string
  private fallbackLocale: string | undefined
  private messages: Record<string, TranslationMessages>
  private pluralizationRules: Record<string, PluralizationRule>
  private onMissingKey?: (key: string, locale: string) => string | undefined

  constructor(options: TranslatorOptions) {
    this.locale = options.locale
    this.fallbackLocale = options.fallbackLocale
    this.messages = options.messages ?? {}
    this.pluralizationRules = options.pluralizationRules ?? {}
    this.onMissingKey = options.onMissingKey
  }

  /**
   * Translate a key.
   */
  t(key: string, replacements?: ReplacementValues): string {
    return this.translate(key, replacements)
  }

  /**
   * Translate a key with count for pluralization.
   */
  tc(key: string, count: number, replacements?: ReplacementValues): string {
    const translation = this.getRawTranslation(key, this.locale)
      ?? this.getRawTranslation(key, this.fallbackLocale)

    if (!translation) {
      return this.handleMissingKey(key)
    }

    // Get pluralization rule
    const rule = this.pluralizationRules[this.locale]
      ?? getPluralizationRule(this.locale)

    // Select plural form
    const pluralized = selectPluralForm(translation, count, rule)

    // Apply replacements including count
    return this.applyReplacements(pluralized, { count, ...replacements })
  }

  /**
   * Check if a translation exists.
   */
  has(key: string, locale?: string): boolean {
    const targetLocale = locale ?? this.locale
    return this.getRawTranslation(key, targetLocale) !== undefined
  }

  /**
   * Get the current locale.
   */
  getLocale(): string {
    return this.locale
  }

  /**
   * Set the current locale.
   */
  setLocale(locale: string): void {
    this.locale = locale
  }

  /**
   * Get the fallback locale.
   */
  getFallbackLocale(): string | undefined {
    return this.fallbackLocale
  }

  /**
   * Set the fallback locale.
   */
  setFallbackLocale(locale: string | undefined): void {
    this.fallbackLocale = locale
  }

  /**
   * Add messages for a locale.
   */
  addMessages(locale: string, messages: TranslationMessages): void {
    this.messages[locale] = this.mergeMessages(
      this.messages[locale] ?? {},
      messages
    )
  }

  /**
   * Set messages for a locale (replaces existing).
   */
  setMessages(locale: string, messages: TranslationMessages): void {
    this.messages[locale] = messages
  }

  /**
   * Get all messages for a locale.
   */
  getMessages(locale?: string): TranslationMessages {
    return this.messages[locale ?? this.locale] ?? {}
  }

  /**
   * Get available locales.
   */
  getAvailableLocales(): string[] {
    return Object.keys(this.messages)
  }

  /**
   * Set a custom pluralization rule.
   */
  setPluralizationRule(locale: string, rule: PluralizationRule): void {
    this.pluralizationRules[locale] = rule
  }

  /**
   * Internal translate method.
   */
  private translate(key: string, replacements?: ReplacementValues): string {
    // Try current locale first
    let translation = this.getRawTranslation(key, this.locale)

    // Try fallback locale
    if (translation === undefined && this.fallbackLocale) {
      translation = this.getRawTranslation(key, this.fallbackLocale)
    }

    // Handle missing translation
    if (translation === undefined) {
      return this.handleMissingKey(key)
    }

    // Apply replacements
    return this.applyReplacements(translation, replacements)
  }

  /**
   * Get raw translation without replacements.
   */
  private getRawTranslation(key: string, locale?: string): string | undefined {
    if (!locale) return undefined

    const messages = this.messages[locale]
    if (!messages) return undefined

    // Support nested keys with dot notation
    const parts = key.split('.')
    let result: string | TranslationMessages | undefined = messages

    for (const part of parts) {
      if (result === undefined || typeof result === 'string') {
        return undefined
      }
      result = result[part]
    }

    return typeof result === 'string' ? result : undefined
  }

  /**
   * Apply replacements to a translation string.
   */
  private applyReplacements(
    translation: string,
    replacements?: ReplacementValues
  ): string {
    if (!replacements) return translation

    let result = translation

    for (const [key, value] of Object.entries(replacements)) {
      // Support both :key and {key} formats. The key is escaped so regex
      // metacharacters match literally, and the value goes through a
      // callback so `$` sequences in it are not expanded.
      const escaped = key.replace(REGEXP_SPECIALS, '\\$&')
      const replacement = (): string => String(value)
      result = result
        .replace(new RegExp(`:${escaped}`, 'g'), replacement)
        .replace(new RegExp(`\\{${escaped}\\}`, 'g'), replacement)
    }

    return result
  }

  /**
   * Handle missing translation key.
   */
  private handleMissingKey(key: string): string {
    if (this.onMissingKey) {
      const result = this.onMissingKey(key, this.locale)
      if (result !== undefined) {
        return result
      }
    }
    return key
  }

  /**
   * Deep merge messages.
   */
  private mergeMessages(
    target: TranslationMessages,
    source: TranslationMessages
  ): TranslationMessages {
    const result = { ...target }

    for (const [key, value] of Object.entries(source)) {
      if (
        typeof value === 'object' &&
        value !== null &&
        typeof result[key] === 'object' &&
        result[key] !== null
      ) {
        result[key] = this.mergeMessages(
          result[key] as TranslationMessages,
          value as TranslationMessages
        )
      } else {
        result[key] = value
      }
    }

    return result
  }
}
