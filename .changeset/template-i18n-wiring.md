---
'create-guren-app': minor
'@guren/testing': minor
---

Wire i18n into the starter templates

Scaffolded apps now ship a `lang/en/messages.json` catalog and pass
`i18n: { supported: ['en'] }` to `createApp`, with the home page message
translated through `this.t()` — adding a locale directory is all it takes
to translate the app. The template test boots the real `src/app.ts` and
wraps it with `TestApp.fromFetch()`, so tests always exercise the app's
actual configuration.

`TestApp.create()` additionally accepts an `i18n` option mirroring
`createApp({ i18n })`, for tests that assemble an app from parts and hit
controllers using `this.t()`.
