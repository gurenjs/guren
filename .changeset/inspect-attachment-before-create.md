---
'@guren/core': minor
'@guren/cli': patch
---

`Attachable` models gain `inspectAttachment(collection, source, options?)`, which runs the gates `attach()` would run in the same call (image policy, byte cap, header dimensions, HEIC policy, and the full decode unless it is queued or the runtime has no image processor) before the owning record exists, and writes nothing. It throws what `attach()` throws, so a controller can reject an upload ahead of `create()` or `update()` and no row is left for a resubmitted form to duplicate. Pass its result to `attach()`, which stores the file without inspecting it again.

```ts
const file = await this.file('cover')
const cover = file ? await Post.inspectAttachment('cover', file) : null
const post = await Post.create(data)
if (cover) await Post.attach(post.id, 'cover', cover)
```

`make:feature --attach` and `guren add resource --attach` now generate a `store()` of this shape. The generated code needs an `@guren/core` that has `inspectAttachment()`. `--attach` refuses a collection named `<name>File` beside a `one` collection `<name>`, since the generated action binds the upload under that name.
