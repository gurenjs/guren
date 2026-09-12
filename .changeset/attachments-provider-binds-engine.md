---
"@guren/cli": minor
---

Bind the attachment engine from the scaffolded `AttachmentsProvider`

`guren add attachments` now writes a `config/attachments.ts` that exports the
engine (`export const { Attachment, engine: attachmentEngine }`) and an
`AttachmentsProvider` whose `register()` calls
`attachmentEngine.bindTo(this.container)`. The scaffolded app's signed
delivery route then serves from the engine of the app that received the
request, and the `storage` factory resolves on that app's container, instead
of both falling back to whichever app configured attachments last in the
process (RFC 0023 §4).
