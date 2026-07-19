---
'@guren/server': minor
---

Add `detectLocaleMiddleware`: resolves the request locale from the `?locale=` query parameter, a `locale` cookie, or the `Accept-Language` header (region subtags and q-values understood), restricted to a supported-locales allowlist. Sets the `locale` context variable — feeding the `<html lang>` attribute of Inertia responses — and binds request-scoped `t`/`tc` translator helpers when the i18n manager is registered.
