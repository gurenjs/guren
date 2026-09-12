---
"@guren/core": minor
---

`configureAttachments()` binds the engine as `attachments` on `app.container`
when given `{ app }`, and the delivery route resolves it from the request's
container ahead of the process-wide active engine (RFC 0023 Part 1). The
`storage` factory receives the container it should resolve from: `app`'s, else
the default application's, so `storage: (container) => container.make('storage')`
replaces `() => getContainer().make('storage')`. Queued variant generation
dispatches through the manager `configureAttachments({ queue })` resolves
rather than pinning its driver globally. Re-exports the Part 1 server changes.
