/**
 * Translation messages type - nested object structure.
 */
export type TranslationMessages = {
  [key: string]: string | TranslationMessages
}

/**
 * Registry for the app's generated translation keys. `guren codegen` emits
 * `.guren/translations.gen.ts`, which augments this interface (declaration
 * merging) with a `keys` union derived from `lang/<locale>/*.json`. Apps
 * without the generated file leave it empty and translation helpers accept
 * any string.
 */
export interface GurenTranslationKeys {}

/**
 * The app's translation-key union when codegen registered one, else `string`.
 * Used by `Controller.t()`/`Controller.tc()` for compile-time key checking.
 */
export type RegisteredTranslationKey = GurenTranslationKeys extends { keys: infer K extends string }
  ? K
  : string

/**
 * Replacement values for interpolation.
 */
export type ReplacementValues = Record<string, string | number>

/**
 * Pluralization rule function.
 */
export type PluralizationRule = (count: number) => number

/**
 * Translation loader interface.
 */
export interface TranslationLoader {
  /**
   * Load translations for a locale.
   */
  load(locale: string): Promise<TranslationMessages>

  /**
   * Load translations for a specific namespace.
   */
  loadNamespace?(locale: string, namespace: string): Promise<TranslationMessages>

  /**
   * Get available locales.
   */
  getAvailableLocales?(): Promise<string[]>
}

/**
 * Translator options.
 */
export interface TranslatorOptions {
  /**
   * Default locale.
   */
  locale: string

  /**
   * Fallback locale when translation is missing.
   */
  fallbackLocale?: string

  /**
   * Translation loader.
   */
  loader?: TranslationLoader

  /**
   * Preloaded messages.
   */
  messages?: Record<string, TranslationMessages>

  /**
   * Custom pluralization rules per locale.
   */
  pluralizationRules?: Record<string, PluralizationRule>

  /**
   * Missing key handler.
   */
  onMissingKey?: (key: string, locale: string) => string | undefined
}

/**
 * I18n manager configuration.
 */
export interface I18nConfig {
  /**
   * Default locale.
   */
  locale: string

  /**
   * Fallback locale.
   */
  fallbackLocale?: string

  /**
   * Path to translation files (constructs a JsonLoader internally).
   */
  path?: string

  /**
   * Custom translation loader (e.g. JsonLoader, MemoryLoader).
   * Takes precedence over `path`.
   */
  loader?: TranslationLoader

  /**
   * Preloaded messages.
   */
  messages?: Record<string, TranslationMessages>
}

/**
 * Translation loader factory.
 */
export type TranslationLoaderFactory = () => TranslationLoader
