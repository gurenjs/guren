---
'@guren/server': minor
---

Add `detectLocaleMiddleware`: resolves the request locale from the `?locale=` query parameter, a `locale` cookie, or the `Accept-Language` header (region subtags and q-values understood), restricted to a supported-locales allowlist. Sets the `locale` context variable — feeding the `<html lang>` attribute of Inertia responses — and binds request-scoped `t`/`tc` translator helpers when an i18n manager is available (the `setI18n()` global, or one passed via the `i18n` option). Also fixes the `<html lang>` i18n fallback in `Controller.inertia` to read the router-injected container (the previous context-variable lookup never fired in real apps).
