// Generated from lang/ (locales: en) — DO NOT EDIT
// Run `guren codegen` to regenerate.

/**
 * Every translation key present in at least one locale. Missing-per-locale
 * keys are reported by `guren check --i18n`, not here.
 */
export type TranslationKey =
  | 'messages.welcome'

// Type this app's translation helpers via declaration merging:
// `this.t()` / `this.tc()` in controllers and `useTranslation()` in pages
// autocomplete and reject unknown keys. Delete lang/ and regenerate to
// return them to plain strings.
declare module '@guren/core' {
  interface GurenTranslationKeys {
    keys: TranslationKey
  }
}

declare module '@guren/inertia-client' {
  interface GurenTranslationKeys {
    keys: TranslationKey
  }
}
