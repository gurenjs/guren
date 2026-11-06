---
name: attachments
description: "Store files users upload against a model (cover image, avatar, gallery, PDF) with guren add attachments, the Attachable mixin and make:feature --attach (\"image upload\", \"file upload\", \"let users attach files\", \"avatar\", \"profile picture\", \"multipart\", \"store uploads in S3\"). Instead of hand-written multipart parsing or a homemade uploads table."
---

# Attachments Skill

An upload is bytes attached to a model record under a named collection: one
`attachments` table, a storage disk for the bytes, image checks and thumbnail
variants on the way in, and signed URLs on the way out. Never parse multipart
by hand, write files to `public/`, or add an `avatar_path` column.

## Setup (once per app)

```bash
bunx guren add attachments
bun run db:make && bun run db:migrate   # add attachments writes the table, not the migration
```

It adds the `attachments` table to `db/schema.ts`, writes `config/attachments.ts`
and `AttachmentsProvider` (a re-run repairs what is missing), mounts
`registerAttachmentRoutes(router)`, registers `attachments:prune`, and installs
the storage blueprint first when nothing binds `storage`. Uploads go to the
private `local` disk (`./storage/app`) behind the signed delivery route.

## Declaring collections

```typescript
import { Attachable, defineModel, hasManyAttached, hasOneAttached } from '@guren/core'

export class Post extends Attachable(defineModel(posts), {
  cover: hasOneAttached({ image: 'require', variants: { thumb: { width: 320 } } }),
  images: hasManyAttached({ image: 'require' }),
  contract: hasOneAttached(),   // opaque bytes: no image checks, width/height stay null
}) {}
```

Register every attachable model in `Model.morphMap = { Post, User }` so
`bun run console attachments:prune` can tell an orphan from a live record.
Keep the declaration an inline object literal: `bunx guren codegen` reads it
statically into `.guren/attachments.gen.ts` (`AttachmentsMap`,
`AttachmentVariantsMap`) and skips, with a warning, one it cannot parse.

A new entity scaffolds attachment-aware (it refuses before `add attachments`):

```bash
bunx guren make:feature Post --fields "title:string,body:text" --attach "cover:one,images:many"
```

`store()` attaches and `destroy()` purges. Add the `<input type="file">` fields
to the New page yourself (Inertia's `useForm` posts multipart once the data
holds a `File`), and the attach lines to `update()`.

## The controller

```typescript
import { Controller, ValidationException } from '@guren/core'

async store() {
  const data = await this.validateBody(CreatePostSchema)        // text fields of the same multipart body
  const contract = await this.file('contract')                   // null when missing or empty
  if (contract && contract.size > 10_000_000) {                  // check before anything is written
    throw new ValidationException({ contract: ['The contract may not exceed 10 MB.'] })
  }
  const post = await Post.create(data)
  const cover = await this.file('cover')
  if (cover) await Post.attach(post.id, 'cover', cover)          // hasOne: replaces the old one
  for (const file of await this.files('images')) await Post.attach(post.id, 'images', file)  // hasMany: appends
  if (contract) await Post.attach(post.id, 'contract', contract)
  return this.redirect(`/posts/${post.id}`)
}

async destroy() {
  const { id } = this.validateParams(PostIdParamSchema)
  await Post.purgeAttachments(id)   // no foreign key, no cascade: purge before deleting the row
  await Post.delete({ id })
  return this.redirect('/posts')
}
```

- Type rules live on the collection: `image: 'require'` rejects a non-image
  with 422 keyed on the collection name (Inertia forms show it), `'allow'`
  measures images and stores the rest opaque, `'forbid'` rejects images. The
  bytes decide; the browser's `file.type` is never trusted.
- Size caps are engine-wide and image-only (`maxImageBytes` 413, `maxPixels`
  422). No per-collection size or MIME option exists: cap other files by hand
  as above. HEIC answers 415 unless the collection sets `accepts: { heic: 'convert' }`.
- `attach()` takes `File | Blob | Uint8Array`, never a path string. Remove with
  `Post.detach(id, 'cover')` or `Post.detach(id, 'images', attachmentId)`.
- A soft delete keeps the attachments; purge on `forceDelete`.

Variants are generated at attach time on Bun with `Bun.Image` and fall back to
the original URL elsewhere. `attach(..., { queued: true })` moves them to a job,
which needs a queue the app shares across processes (`configureAttachments({ queue })`,
or the app's booted queue; `attach()` throws without one) and a `bunx guren queue:work`
worker running on Bun, since a worker with no image processor settles them `unavailable`.
On Workers that means a Redis-backed queue and a separate Bun worker.

## Rendering URLs

```typescript
const [withCover] = await Post.withAttachments([post], ['cover'])   // one query for a whole page of records
return this.inertia(pages.posts.Show, { post: new PostResource(withCover!).toJSON() })
```

The Resource `make:feature` writes serializes only the scalar columns, so add the
collection to its input type, its payload and `toArray()`, or `cover` is dropped:

```typescript
import { Resource, type AttachmentData } from '@guren/core'

type PostInput = PostRecord & { cover?: AttachmentData | null }   // records that skipped withAttachments() send null

export interface PostResourceData extends Record<string, unknown> {
  id: number
  title: string
  cover: AttachmentData | null
}

export class PostResource extends Resource<PostInput, PostResourceData> {
  toArray(): PostResourceData {
    const post = this.resource
    return { id: post.id, title: post.title, cover: post.cover ?? null }
  }
}
```

Each collection arrives as `AttachmentData` from `@guren/core` (`url`, `name`,
`contentType`, `size`, `width`, `height`, `placeholder`, `variants`); render
`cover.url`, or ask `Post.attachmentUrl(post, 'cover', { variant: 'thumb' })`.
Never build a URL from `path`. A private URL expires (`urlExpiresIn`, 5 minutes
by default), so never store it in a row or a long-lived cache.

Visibility is per disk in `configureAttachments({ disks })`, and an undeclared
disk counts as public. A private disk serves through the delivery route, whose
`serve` mode per disk is `'auto'` (default), `'redirect'`, `'proxy'` or
`'direct'`. `redirect` needs a driver that can presign: `s3` can, R2 only with
`presign` credentials, `local` and `memory` cannot (they proxy).

## Production disk

The local disk lives on one server's filesystem. Lambda has a read-only
filesystem except an ephemeral `/tmp`, and Workers has none, so uploads there
need S3, an S3-compatible service, or R2 (`r2Disk()` from
`@guren/plugin-cloudflare` on Workers). To move attachments:

1. Install the SDK, an optional peer the S3 driver imports on first use:
   `bun add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`.
2. Add an `s3` disk to `config/storage.ts` (`bucket`, `region`, `endpoint` for
   S3-compatible services, `accessKeyId`, `secretAccessKey`). Declare every key
   it reads (`AWS_BUCKET`, `AWS_ACCESS_KEY_ID`, …) in `config/env.ts`, as
   `.optional()` unless every environment sets it.
3. In `config/attachments.ts`, set `disk: 's3'` and add `s3: 'private'` to
   `disks`. `STORAGE_DISK` alone does not move attachments: they use their own
   `disk`.
4. With several instances, pass `withCollectionLock` so concurrent `hasOne`
   replacements serialize across processes.

## Check it

```bash
bunx guren check
```

| Key | Fix |
|-----|-----|
| `attachments-model:<file>` | No `configureAttachments()` runs: `bunx guren add attachments`, or import the config from a registered provider |
| `attachments-config:<file>` | Export the bound table from `db/schema.ts`, or bind the export that exists |
| `attachments-public-disk:<file>:<disk>` | The disk is rooted under `public/`: use `local` (`./storage/app`), declare it private, serve through `delivery` |
| `attachments-delivery:<file>` | `delivery` is on but the route is not mounted: call `registerAttachmentRoutes(router)` from the registrar |
| `attachments-serve-redirect:<file>:<disk>` | `serve: 'redirect'` on a driver that cannot presign: use `'proxy'`/`'auto'`, or a presigning driver |
| `attachments-route-name:<name>` | Another route has the delivery route's name: rename it, or set `delivery.routeName` |
| `attachments-delivery-unverified:*`, `attachments-serve-redirect-unverified:*` | Advisory: the app was not introspected. Run `bunx guren introspect` and make the provider it names register cleanly |

`bunx guren audit` counts a typed `attach()` as validation for the upload;
other body fields still need `validateBody()` or a route `body` schema.

## Testing an upload

Set up `http` with `TestApp.fromApp(app)` and `resetDatabase()` as
`__RULES_DIR__/testing.md` shows, then:

```typescript
test('a non-image cover is rejected', async () => {
  const user = await User.create({ name: 'A', email: 'a@example.com', password: 'secret' })
  const form = new FormData()
  form.append('title', 'Hello')
  form.append('body', 'Body')
  form.append('cover', new File(['not an image'], 'cover.txt', { type: 'image/png' }))
  const csrf = await http.actingAs(user).json().withCsrf()   // prime after actingAs()
  await csrf.post('/posts', form).assertUnprocessable()
})
```

`TestApp` sends a `FormData` body as multipart. A passing upload on an
`image: 'require'` collection needs a real image: append a fixture file
(`Bun.file('tests/fixtures/cover.png')`), not a few made-up bytes. Under
`bun test` the scaffolded `local` disk writes to `./storage/app/testing`. A
Vitest file posting a `File` needs `// @vitest-environment node` on line 1.

Full guide: https://guren.dev/docs/guides/attachments.
