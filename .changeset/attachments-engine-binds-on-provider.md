---
"@guren/core": minor
---

Return the attachment engine so a provider can bind it on the app

`configureAttachments()` now returns `engine` beside `Attachment`, and
`AttachmentEngine.bindTo(container)` binds it as the `attachments` service
*and* becomes the container its `storage` factory resolves from.

The per-app binding was unreachable before this. `configureAttachments()` is
called at module scope in `config/attachments.ts`, which `AttachmentsProvider`
imports for its side effect, and no `Application` exists at that point, so
every app's delivery route still resolved the process-wide active engine and
two apps in one process shared it. The provider binds instead:

```ts
// app/Providers/AttachmentsProvider.ts
import { attachmentEngine } from '../../config/attachments'

export default class AttachmentsProvider extends ServiceProvider {
  register(): void {
    attachmentEngine.bindTo(this.container)
  }
}
```

The active engine stays the fallback for the `Attachable` statics, the queued
variants job and `attachments:prune`, none of which hold a container.

**Removed:** the unreleased `configureAttachments({ app })` option (RFC 0023
§4, amended). No shipped release carried it.
