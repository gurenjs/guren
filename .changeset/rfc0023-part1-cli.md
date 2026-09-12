---
"@guren/cli": minor
---

`guren queue:work` resolves the driver from the `queue` manager the booted
app's container binds and hands that container to the `Worker`, so each job's
`this.make()` resolves from the app it belongs to (RFC 0023 Part 1). The
scaffolded `MailProvider` drops its `boot()` and passes the container to
`createMailManager()`; the scaffolded `config/attachments.ts` resolves storage
through the container the factory receives instead of `getContainer()`.
