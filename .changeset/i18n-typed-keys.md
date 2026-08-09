---
'@guren/cli': minor
'@guren/server': minor
'@guren/inertia-client': minor
---

Typed translation keys and translation catalog checks

`guren codegen` now emits `.guren/translations.gen.ts` for apps with a
`lang/` directory: a `TranslationKey` union built from every
`lang/<locale>/*.json` catalog (namespace = file name, nested keys
flattened to dot notation), plus declaration-merging augmentations that
register it with the server and client. `this.t()` / `this.tc()` in
controllers and `useTranslation()` in pages then autocomplete keys and
reject unknown ones at compile time. Apps without `lang/` (or without the
generated file) keep plain `string` keys — the new `GurenTranslationKeys`
registry defaults to empty. The Vite route-types plugin watches `lang/`
and regenerates on change.

`guren check` gains translation catalog checks, content-activated like
`--docs`: unparseable catalog JSON (fail — the loader silently skips such
files), keys missing from individual locales (fail — they render in the
fallback language), and interpolation placeholders that differ between
locales for the same key (warn). `guren check --i18n` runs them alone and
exits non-zero on failures.
