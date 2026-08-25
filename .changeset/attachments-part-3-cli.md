---
'@guren/cli': minor
---

Teach the agent commands about attachments (RFC 0013 Part 3):
`guren check` now fails when `configureAttachments()` binds a table its
`db/schema.ts` does not export (the layer takes the table untyped, so this
otherwise only surfaces at runtime), and `guren audit` recognizes uploads
handed to a typed `attach()` as validated by the attachment declaration's
pipeline instead of demanding `validateBody()` for them.
