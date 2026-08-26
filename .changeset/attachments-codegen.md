---
'@guren/cli': minor
---

Add attachments codegen (RFC 0013 Open Question 4, RFC 0010 §2): `guren
codegen` now reads each model's `Attachable(...)` declaration and emits
`.guren/attachments.gen.ts` with `AttachmentsMap` (collection name → 'one' |
'many', keyed by model class name) and `AttachmentVariantsMap` (declared
variant names per collection). Apps without Attachable models get no file —
a stale one is removed — and a declaration that cannot be statically read is
skipped with a warning rather than emitted partially. The Vite plugin
regenerates the map when `app/Models/**` (or a module's) changes, `guren
context <Entity>` lists the entity's attachment collections, and `guren
check` flags models mixing in `Attachable(...)` in an app with no
`configureAttachments()` call.
