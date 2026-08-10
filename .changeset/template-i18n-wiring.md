---
'create-guren-app': minor
'@guren/testing': minor
---

Wire i18n into the starter templates

Apps scaffolded from the default and blog blueprints now ship a
`lang/en/messages.json` catalog and pass `i18n: { supported: ['en'] }` to
`createApp`; the default blueprint's home page message renders through
`this.t()`. Adding a locale directory is all it takes to translate the
app.

`TestApp.create()` additionally accepts an `i18n` option mirroring
`createApp({ i18n })`, for tests that assemble an app from parts and hit
controllers using `this.t()`.
