---
'@guren/server': minor
---

Localize the root `<html lang>` attribute of Inertia responses. Controllers can set it per response with `this.inertia(page, props, { lang: 'ja' })`, and when the option is omitted it is derived automatically: a request-scoped `locale` context variable (set by locale-detection middleware via `c.set('locale', ...)`) wins over the app-wide i18n locale (`I18nServiceProvider`), falling back to `"en"`.
