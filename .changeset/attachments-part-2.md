---
'@guren/core': minor
---

Add queued variant generation for attachments (RFC 0013 Part 2):
`attach(..., { queued: true })` runs only the synchronous gates in the
request path, stores the original, seeds declared variants as `pending`,
and dispatches `GenerateVariantsJob` — registered automatically by
`configureAttachments()`, which now also wires the `queue` option to it. A
worker runs the deferred full decode (purging lying bytes on
`image: 'require'` collections), converts HEIC originals where the
collection opted in, generates the variants, and settles every `pending`
status record; variant URLs keep falling back to the original until then.
