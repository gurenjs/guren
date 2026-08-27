---
'@guren/cli': minor
---

Add `guren make:feature --attach "cover:one,images:many"` (RFC 0013 Part 4):
wraps the generated model in the `Attachable` mixin (`hasOneAttached` /
`hasManyAttached` with `image: 'require'`), wires the store action to read
uploads via `this.file()` / `this.files()` and `Model.attach()`, and makes
the destroy action call `Model.purgeAttachments()` before deleting the row —
deletion is explicit because the polymorphic attachment rows carry no foreign
key. The flag is refused, with guidance to run `guren add attachments` first,
when the app has no `configureAttachments()`. `guren add resource` passes
`--attach` through.
