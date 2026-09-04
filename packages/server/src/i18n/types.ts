/** Translation messages type - nested object structure. */
export type TranslationMessages = {
  [key: string]: string | TranslationMessages
}

/**
 * Registry for the app's generated translation keys: `guren codegen` emits
 * `.guren/translations.gen.ts`, which merges a `keys` union into this interface.
 * Left empty, translation helpers accept any string.
 */
export interface GurenTranslationKeys {}

/**
 * The app's translation-key union when codegen registered one, else `string`.
 * Used by `Controller.t()`/`Controller.tc()` for compile-time key checking.
 */
export type RegisteredTranslationKey = GurenTranslationKeys extends { keys: infer K extends string }
  ? K
  : string

/** Replacement values for interpolation. */
export type ReplacementValues = Record<string, string | number>

/** Pluralization rule function. */
export type PluralizationRule = (count: number) => number

/** Translation loader interface. */
export interface TranslationLoader {
  load(locale: string): Promise<TranslationMessages>

  loadNamespace?(locale: string, namespace: string): Promise<TranslationMessages>

  getAvailableLocales?(): Promise<string[]>
}

/** Translator options. */
export interface TranslatorOptions {
  locale: string

  /** Fallback locale when translation is missing. */
  fallbackLocale?: string

  /** Translation loader. */
  loader?: TranslationLoader

  messages?: Record<string, TranslationMessages>

  /** Custom pluralization rules per locale. */
  pluralizationRules?: Record<string, PluralizationRule>

  /** Missing key handler. */
  onMissingKey?: (key: string, locale: string) => string | undefined
}

/** I18n manager configuration. */
export interface I18nConfig {
  locale: string

  /** Fallback locale. */
  fallbackLocale?: string

  /** Path to translation files (constructs a JsonLoader internally). */
  path?: string

  /** Takes precedence over `path`. */
  loader?: TranslationLoader

  messages?: Record<string, TranslationMessages>
}

/** Translation loader factory. */
export type TranslationLoaderFactory = () => TranslationLoader
