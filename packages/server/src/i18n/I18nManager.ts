import type {
  TranslationMessages,
  TranslationLoader,
  I18nConfig,
  ReplacementValues,
} from './types'
import { Translator } from './Translator'
import { JsonLoader } from './loaders/JsonLoader'

export class I18nManager {
  private config: I18nConfig
  private translator: Translator
  private loader: TranslationLoader | null
  private loadedLocales: Set<string> = new Set()

  constructor(config: I18nConfig) {
    this.config = config
    this.loader = config.loader ?? (config.path ? new JsonLoader(config.path) : null)

    this.translator = new Translator({
      locale: config.locale,
      fallbackLocale: config.fallbackLocale,
      messages: config.messages ?? {},
    })

    if (config.messages) {
      for (const locale of Object.keys(config.messages)) {
        this.loadedLocales.add(locale)
      }
    }
  }

  t(key: string, replacements?: ReplacementValues): string {
    return this.translator.t(key, replacements)
  }

  /** Translate a key with count for pluralization. */
  tc(key: string, count: number, replacements?: ReplacementValues): string {
    return this.translator.tc(key, count, replacements)
  }

  has(key: string, locale?: string): boolean {
    return this.translator.has(key, locale)
  }

  getLocale(): string {
    return this.translator.getLocale()
  }

  setLocale(locale: string): void {
    this.translator.setLocale(locale)
  }

  getFallbackLocale(): string | undefined {
    return this.translator.getFallbackLocale()
  }

  setFallbackLocale(locale: string | undefined): void {
    this.translator.setFallbackLocale(locale)
  }

  async loadLocale(locale: string): Promise<void> {
    if (this.loadedLocales.has(locale)) return
    if (!this.loader) return

    const messages = await this.loader.load(locale)
    this.translator.addMessages(locale, messages)
    this.loadedLocales.add(locale)
  }

  async loadLocales(locales: string[]): Promise<void> {
    await Promise.all(locales.map((locale) => this.loadLocale(locale)))
  }

  /** Load a specific namespace for a locale. */
  async loadNamespace(locale: string, namespace: string): Promise<void> {
    if (!this.loader?.loadNamespace) return

    const messages = await this.loader.loadNamespace(locale, namespace)
    const currentMessages = this.translator.getMessages(locale)

    this.translator.setMessages(locale, {
      ...currentMessages,
      [namespace]: messages,
    })
  }

  addMessages(locale: string, messages: TranslationMessages): void {
    this.translator.addMessages(locale, messages)
    this.loadedLocales.add(locale)
  }

  getMessages(locale?: string): TranslationMessages {
    return this.translator.getMessages(locale)
  }

  getAvailableLocales(): string[] {
    return this.translator.getAvailableLocales()
  }

  /** Get available locales from loader. */
  async getLoaderLocales(): Promise<string[]> {
    if (!this.loader?.getAvailableLocales) return []
    return this.loader.getAvailableLocales()
  }

  isLocaleLoaded(locale: string): boolean {
    return this.loadedLocales.has(locale)
  }

  getTranslator(): Translator {
    return this.translator
  }

  setLoader(loader: TranslationLoader): void {
    this.loader = loader
  }

  /** Create a scoped translator for a specific locale. */
  forLocale(locale: string): Translator {
    return new Translator({
      locale,
      fallbackLocale: this.config.fallbackLocale,
      messages: this.messagesForLocale(locale),
    })
  }

  /**
   * The fallback locale's catalog (when it differs) then the locale's own, so a
   * consumer flattening the record lets the active locale win on collisions.
   */
  messagesForLocale(locale: string): Record<string, TranslationMessages> {
    const fallback = this.config.fallbackLocale
    const messages: Record<string, TranslationMessages> = {}
    if (fallback && fallback !== locale) {
      messages[fallback] = this.translator.getMessages(fallback)
    }
    messages[locale] = this.translator.getMessages(locale)
    return messages
  }
}

let globalI18n: I18nManager | null = null

/** Create a new I18n manager. */
export function createI18n(config: I18nConfig): I18nManager {
  return new I18nManager(config)
}

/** Set the global I18n manager. */
export function setI18n(i18n: I18nManager): void {
  globalI18n = i18n
}

/** Get the global I18n manager. */
export function getI18n(): I18nManager {
  if (!globalI18n) {
    throw new Error('I18n manager not initialized. Call setI18n() first.')
  }
  return globalI18n
}

/** Get the global I18n manager, or `undefined` when none was registered. */
export function tryGetI18n(): I18nManager | undefined {
  return globalI18n ?? undefined
}

/** Translate a key using the global I18n manager. */
export function t(key: string, replacements?: ReplacementValues): string {
  return getI18n().t(key, replacements)
}

/** Translate a key with count using the global I18n manager. */
export function tc(key: string, count: number, replacements?: ReplacementValues): string {
  return getI18n().tc(key, count, replacements)
}
