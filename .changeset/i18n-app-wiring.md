---
'@guren/server': minor
---

Wire i18n into the application: `createApp({ i18n })`, controller translation helpers, and Inertia `_i18n` shared props

The i18n subsystem (I18nManager, Translator, pluralization, loaders) existed
but had no path from an app's configuration into a request. `createApp` now
accepts an `i18n` option:

```ts
createApp({
  i18n: {
    supported: ['en', 'ja'],   // first entry is the default fallback
    path: 'lang',              // lang/<locale>/*.json via JsonLoader (default)
    // loader: new MemoryLoader(...)  // e.g. bundled messages on serverless
  },
})
```

When set, `I18nServiceProvider` builds the `i18n` container binding from the
options, preloads every supported locale during `boot()`, and mounts
`detectLocaleMiddleware` (query → cookie → `Accept-Language`, opt out with
`detect: false`). Apps that register their own `I18nServiceProvider` subclass
keep ownership of the wiring.

Controllers gain request-locale sugar: `this.t(key, replacements?)`,
`this.tc(key, count, replacements?)`, and `this.locale`. They use the
request-scoped translator bound by the locale middleware when present, and
fall back to a translator scoped to the resolved locale from the container's
`i18n` binding (then the `setI18n()` global) — the same resolution order the
Inertia `<html lang>` default already used.

Inertia responses share the resolved locale and its messages as the `_i18n`
prop (`{ locale, fallbackLocale, messages }`, active locale plus fallback
only; disable with `share: false`), laying the groundwork for a client-side
`useTranslation()` hook.
