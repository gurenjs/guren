# Attachments Guide

Attachments connect uploaded files to your models: a `Post` has a `cover`
image and many `images`, each stored on a [storage disk](./storage.md),
tracked in one `attachments` table, with image validation and thumbnail
variants built in. Declarations live on the model, so collection names,
one/many kinds, and variant names are all checked at compile time.

```ts
import { Attachable, defineModel, hasOneAttached, hasManyAttached } from '@guren/core'
import { posts } from '@/db/schema'

export class Post extends Attachable(defineModel(posts), {
  cover: hasOneAttached({
    image: 'require',
    variants: { thumb: { width: 320 }, og: { width: 1200 } },
  }),
  images: hasManyAttached({ image: 'require' }),
  draftPdf: hasOneAttached(), // opaque bytes; width/height/placeholder stay null
}) {}
```

```ts
// In a controller — one call:
async store() {
  const data = await this.validateBody(CreatePostSchema)
  const post = await Post.create(data)
  const cover = await this.file('cover')
  if (cover) {
    await Post.attach(post.id, 'cover', cover)
  }
  return this.redirect(`/posts/${post.id}`)
}
```

## Setup

> `bunx guren add attachments` performs this whole section for you: it adds
> the table to `db/schema.ts` for your dialect, writes
> `config/attachments.ts`, wires an `AttachmentsProvider`, registers the
> [`attachments:prune`](#sweeping-orphans-attachmentsprune) command, and
> installs the storage blueprint if the app has none. The steps below are
> the manual equivalent.

### 1. Add the `attachments` table

Your app owns the table (the same convention as the sessions table): add the
snippet for your dialect to `db/schema.ts` and run a migration.

**PostgreSQL** (timestamps must use `withTimezone: true` — `guren check`
enforces this):

```ts
import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const attachments = pgTable('attachments', {
  id: text('id').primaryKey(),                       // ULID
  attachableType: text('attachable_type').notNull(), // model class name
  attachableId: text('attachable_id').notNull(),     // text covers int and uuid PKs
  collection: text('collection').notNull().default('default'),
  disk: text('disk').notNull(),
  path: text('path').notNull(),
  name: text('name').notNull(),
  contentType: text('content_type').notNull(),
  size: integer('size').notNull(),
  width: integer('width'),
  height: integer('height'),
  variants: jsonb('variants').$type<Record<string, AttachmentVariantRecord>>(),
  placeholder: text('placeholder'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('attachments_attachable_idx').on(t.attachableType, t.attachableId, t.collection)])
```

**MySQL:**

```ts
import { index, int, json, mysqlTable, text, timestamp, varchar } from 'drizzle-orm/mysql-core'

export const attachments = mysqlTable('attachments', {
  id: varchar('id', { length: 26 }).primaryKey(),
  attachableType: varchar('attachable_type', { length: 255 }).notNull(),
  attachableId: varchar('attachable_id', { length: 255 }).notNull(),
  collection: varchar('collection', { length: 255 }).notNull().default('default'),
  disk: varchar('disk', { length: 255 }).notNull(),
  path: varchar('path', { length: 1024 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  contentType: varchar('content_type', { length: 255 }).notNull(),
  size: int('size').notNull(),
  width: int('width'),
  height: int('height'),
  variants: json('variants').$type<Record<string, AttachmentVariantRecord>>(),
  placeholder: text('placeholder'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (t) => [index('attachments_attachable_idx').on(t.attachableType, t.attachableId, t.collection)])
```

**SQLite:**

```ts
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const attachments = sqliteTable('attachments', {
  id: text('id').primaryKey(),
  attachableType: text('attachable_type').notNull(),
  attachableId: text('attachable_id').notNull(),
  collection: text('collection').notNull().default('default'),
  disk: text('disk').notNull(),
  path: text('path').notNull(),
  name: text('name').notNull(),
  contentType: text('content_type').notNull(),
  size: integer('size').notNull(),
  width: integer('width'),
  height: integer('height'),
  variants: text('variants', { mode: 'json' }).$type<Record<string, AttachmentVariantRecord>>(),
  placeholder: text('placeholder'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => [index('attachments_attachable_idx').on(t.attachableType, t.attachableId, t.collection)])
```

The `variants` column must be JSON-capable (`jsonb` on Postgres, `json` on
MySQL, `text(..., { mode: 'json' })` on SQLite). Import the
`AttachmentVariantRecord` type from `@guren/core`.

### 2. Configure the layer

```ts
// config/attachments.ts
import { configureAttachments } from '@guren/core'
import { attachments } from '@/db/schema'
import { storage } from './storage'

export const { Attachment } = configureAttachments({
  table: attachments,
  storage: () => storage,   // your StorageManager, resolved lazily
  disk: 'media',            // default disk for new attachments
})
```

Import this module once at boot (for example from `src/app.ts`, next to your
other config). The returned `Attachment` is a ready-made model bound to the
table with `morphTo('attachable', 'attachable')` pre-declared — useful for
morph relations and advanced queries. The framework itself deliberately
exports no `Attachment` class; the app-local name comes from this call.

Additional options:

| Option | Default | Purpose |
|---|---|---|
| `disks` | `{}` | Per-disk visibility, e.g. `{ media: 'public', docs: 'private' }`. The object form adds a serve mode: `{ docs: { visibility: 'private', serve: 'proxy' } }` (see [URLs and visibility](#urls-and-visibility)). |
| `delivery` | off | Enables the signed delivery route for private disks: `delivery: {}` (options: `prefix`, `routeName`). Pair it with `registerAttachmentRoutes(router)` in the route registrar. |
| `maxPixels` | `52_000_000` | Decode cap in pixels (decompression-bomb defense). |
| `maxImageBytes` | `50_000_000` | Encoded-input cap in bytes, checked before any decode. |
| `processor` | Bun-native | Custom `ImageProcessor`, or `null` to disable image decoding. |
| `queue` | — | The app's QueueManager, resolved lazily; enables `attach(..., { queued: true })`. |
| `urlExpiresIn` | 5 minutes | Lifetime of private-disk URLs — signed route URLs and `temporaryUrl()` links alike. Per-URL override: `attachmentUrl(rec, 'cover', { expiresIn })`. |

### Scaffolding a feature with attachments

Once the layer is installed, `make:feature` (and `guren add resource`) can
scaffold a whole attachment-aware feature:

```bash
bunx guren make:feature Post --fields "title:string,body:text" --attach "cover:one,images:many"
```

`--attach` takes comma-separated `name:kind` pairs (`one` or `many`; the kind
defaults to `one`). The generated model is wrapped in the `Attachable` mixin
with `image: 'require'` on every collection — drop that option per collection
for non-image uploads — the store action reads matching multipart fields via
`this.file()` / `this.files()` and calls `Post.attach()`, and the destroy
action calls `Post.purgeAttachments()` before deleting the row. The command
refuses to scaffold when the app has no `configureAttachments()`; run
`bunx guren add attachments` first. Add `<input type="file">` fields to the
generated New page yourself — Inertia's `useForm` switches to a multipart
POST automatically when the form data contains a `File`. The generated
`update()` does not touch attachments; to accept uploads from the Edit page
too, add the same `this.file()` + `Post.attach()` lines there (`hasOne`
replaces, `hasMany` appends).

## Working with attachments

All statics are typed against the declaration — a typo in a collection name
or a variant name is a compile error, not a runtime surprise.

```ts
// Attach bytes (File, Blob, or Uint8Array — never a path string)
await Post.attach(post.id, 'cover', file)
await Post.attach(post.id, 'images', file, { name: 'photo.jpg', disk: 'archive' })

// hasOne replaces (the old row and its objects are purged);
// hasMany appends.

// Detach: whole collection, or one attachment on a hasMany
await Post.detach(post.id, 'cover')
await Post.detach(post.id, 'images', attachmentId)

// Load attachments for a page of records (one indexed query)
const withCovers = await Post.withAttachments(posts, ['cover', 'images'])
// → each record gains `cover: AttachmentData | null` and `images: AttachmentData[]`

// URLs
const url = await Post.attachmentUrl(post, 'cover')
const thumb = await Post.attachmentUrl(post, 'cover', { variant: 'thumb' })

// Remove everything a record owns (call this from destroy actions)
await Post.purgeAttachments(post.id)
```

`AttachmentData` is the resource-facing shape — `{ id, collection, name,
contentType, size, width, height, url, placeholder, variants }` — ready to
return from a `JsonResource.toArray()` so pages receive typed attachment
props. `placeholder` is a ThumbHash LQIP data URL you can render while the
real image loads.

### Raw rows via relations

The table follows the ORM's morph convention, so the ordinary relation
machinery works too when you want the rows themselves:

```ts
export class Post extends Attachable(defineModel(posts), { /* … */ }) {}
Post.morphMany('attachments', Attachment, 'attachable')

const loaded = await Post.with('attachments').get() // all collections, raw rows
```

`morphMany` loads *all* collections of a record; the typed per-collection
path is `withAttachments()`.

## Image validation and security

When a collection declares `image: 'require'` (or `'allow'`), uploads pass
a three-gate pipeline:

1. **Byte cap** — input larger than `maxImageBytes` is rejected with 413.
2. **Header dimensions** — a dependency-free header parser (PNG, JPEG, GIF,
   WebP, AVIF/HEIC) reads the declared dimensions and rejects anything over
   `maxPixels` with 422 *before* a decoder allocates pixel buffers.
3. **Full decode** — the image is actually decoded. Truncated or corrupt
   files that lie in their headers fail here with 422. Sniffed and
   client-declared content types are recorded but never trusted for the
   image/not-image decision.

Gates 1 and 2 are pure JavaScript and run on every runtime. Gate 3 runs
wherever an image processor exists (see below); without one, uploads are
accepted on header evidence and dimensions come from the header.

The `image` option per collection:

- unset — opaque bytes: no image pipeline, `width`/`height`/`placeholder`
  stay `null` (documents, archives, …)
- `'allow'` — images are decoded and measured; other files are stored as
  opaque bytes
- `'require'` — non-images are rejected with a 422 `ValidationException`
  (the error keys on the collection name, so Inertia forms display it)
- `'forbid'` — anything that sniffs as an image is rejected with 422

Other rules that hold everywhere:

- **Bytes only.** `attach()` accepts `File | Blob | Uint8Array` and nothing
  else — filesystem path strings are an arbitrary-file-read primitive and
  are rejected at both the type level and runtime.
- **HEIC/HEIF is rejected with 415 by default.** HEIC decoding depends on
  OS codecs — it typically works on a macOS dev machine and fails on Linux
  production, and the default must not let that skew pass silently. Opt in
  with `accepts: { heic: 'convert' }`: the upload is decoded and stored as
  JPEG, and still answers 415 on runtimes whose codecs cannot decode it.
  The rejection applies whenever the image pipeline runs — `image: 'allow'`
  collections included, so an iPhone HEIC photo is 415 there too unless the
  collection opts into `'convert'`; only collections with no `image` policy
  at all store HEIC bytes as opaque files.
- **Filenames are sanitized** (no path separators or control characters)
  before becoming part of an object key.
- **Serving is hardened where the framework serves.** The signed delivery
  route's proxy responses carry the hardening set listed under
  [URLs and visibility](#urls-and-visibility). Public disks still serve
  via `disk.url()` under your own rules: if such a disk serves user
  uploads over your own domain, make sure it sends correct `Content-Type`
  and `X-Content-Type-Options: nosniff` headers itself — an inline SVG
  served as a same-origin page is a script.

## Variants

Declare named variants on the collection; they are generated at attach time:

```ts
cover: hasOneAttached({
  image: 'require',
  variants: {
    thumb: { width: 320 },
    og: { width: 1200, height: 630, fit: 'inside', format: 'webp', quality: 80 },
  },
})
```

`fit` supports `'fill'` and `'inside'` (what the Bun-native processor
actually implements; a crop mode can be added without breaking changes).

Every *declared* variant gets a status entry on the attachment row —
`ready`, `failed`, `unavailable` (no processor on this runtime), or
`pending` (queued generation, below). `attachmentUrl(post, 'cover',
{ variant: 'thumb' })` serves a `ready` variant's own URL and **falls back
to the original's URL** for anything else, so pages keep rendering; a
variant name that was never declared throws instead of silently serving the
original.

### Runtimes and processors

The default processor is Bun-native (`Bun.Image`) and is resolved by
feature detection — image variants and full-decode validation require a Bun
runtime with `Bun.Image` (Bun 1.4; the API first appeared in 1.3.14). On
older Bun versions and non-Bun runtimes (Node/Lambda, Workers):

- attachments still store and serve normally;
- declared variants are recorded as `unavailable` and their URLs fall back
  to the original;
- you can inject any `ImageProcessor` implementation (for example a
  sharp-backed one) via `configureAttachments({ processor })`.

Whether a specific format (HEIC, AVIF) can be decoded or encoded is a
property of the OS codecs, discovered at call time — expect 415 responses
for formats the deployed runtime cannot handle, and test uploads on the
runtime you deploy to.

### Queued generation

`attach(..., { queued: true })` moves the image work off the request path:
the request runs only the synchronous gates (byte cap, header dimensions,
HEIC signature), stores the original, seeds every declared variant as
`pending`, and dispatches `GenerateVariantsJob`. A worker then runs the
deferred full decode, converts HEIC originals where the collection opted
in, generates the variants, and flips the status records to `ready` (or
`failed`). Until it does, variant URLs fall back to the original and the
`placeholder` stays `null`.

```ts
// config/attachments.ts
export const { Attachment } = configureAttachments({
  table: attachments,
  storage: () => storage,
  disk: 'media',
  queue: () => queueManager,   // the app's QueueManager, resolved lazily
})

// anywhere
await Post.attach(post.id, 'cover', file, { queued: true })
```

What to know:

- `configureAttachments()` registers the job, so any worker process that
  boots the app's config (`bunx guren queue:work`) can process it.
  Point the worker at a runtime with an image processor — Bun with
  `Bun.Image`, or a custom `configureAttachments({ processor })`; a worker
  without one settles the variants as `unavailable`.
- Without the `queue` option, `queued: true` dispatches through the app's
  already-booted queue driver, and throws a clear error before writing
  anything when there is none.
- The full decode moves to the worker, so the one class the synchronous
  gates cannot catch — bytes whose header lies — is detected *after*
  acceptance: on an `image: 'require'` collection the job purges the
  attachment; on other collections the bytes stay as an opaque file.
- On Cloudflare Workers this is the only mode that generates variants; see
  the [Cloudflare guide](./cloudflare.md#attachments-on-workers).

## URLs and visibility

Visibility is declared **per disk** in the attachments config, not per
attachment — matching drivers like R2 where visibility is a property of the
bucket:

```ts
configureAttachments({
  // …
  disks: { media: 'public', docs: 'private' },
})
```

Public disks always serve via `disk.url(path)` — CDN-cacheable, zero app
CPU. For private disks there are two modes:

### The signed delivery route (recommended)

Enable `delivery` and mount the route from your route registrar:

```ts
// config/attachments.ts
configureAttachments({
  // …
  disks: { media: 'public', docs: 'private' },
  delivery: {},          // options: prefix ('/attachments'), routeName ('attachments.show')
})

// routes/web.ts
import { registerAttachmentRoutes } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  registerAttachmentRoutes(router)
  // …app routes…
}
```

`attachmentUrl()` on a private disk now returns a **path-relative signed
URL** (`/attachments/{id}/{filename}?expires=…&signature=…`) — HMAC-signed
with a key derived for attachment delivery only, expiring after
`urlExpiresIn` (override per URL with `{ expiresIn }`; force a download
with `{ disposition: 'attachment' }` — guaranteed on proxy responses,
while a redirecting disk depends on its backend honouring the presigned
response overrides, which R2 does not: see the
[Cloudflare guide](./cloudflare.md#attachments-on-workers)). The route
verifies the signature
(any failure is a uniform 404), resolves the variant at serve time — a
declared-but-not-ready variant serves the original, and the same URL
starts serving the variant once generation completes — and then either:

- **redirects** (302) to a short-lived presigned URL on disks whose driver
  declares `capabilities.presignedGet` (S3, R2 with `presign`) — the
  bucket serves the bytes, zero app bandwidth; or
- **proxies** the bytes with hardened headers (inline allowlist, `nosniff`,
  `Content-Security-Policy: sandbox`, `Referrer-Policy: no-referrer`,
  ETag/304) on everything else — which is what finally makes **private on
  the local disk actually private**, and lets **private R2 disks work on
  the binding alone, no `presign` credentials**.

Per-disk override via the `disks` object form:
`{ docs: { visibility: 'private', serve: 'proxy' } }` — `'auto'`
(default), `'redirect'`, `'proxy'`, or `'direct'` (bypass the route and
keep raw `temporaryUrl()` URLs). `guren check` verifies the route is
mounted whenever `delivery` is configured, and flags `serve: 'redirect'`
on a disk whose driver cannot presign.

Two things the route does not do: it is a capability URL, not per-request
authorization (anyone holding an unexpired URL can read the bytes — wrap
`attachmentUrl()` in your own controller for revocable access), and it
cannot un-publish a backing store that is itself public. On a local disk,
also stop serving the private disk's directory statically — registering
the route without closing the public mount is a lock on an open door.

Two operational notes: the signature is a bearer credential in a query
string, so redact query parameters for the route prefix in access logs
(browser history holds them too — one reason the default lifetime is
minutes, not days); and the proxy path serves bytes through your app, so
bandwidth-sensitive apps should rate-limit the prefix with the usual
route middleware and prefer redirect-capable disks.

### Without `delivery` (the v1 behaviour)

Private disks fall back to `disk.temporaryUrl(path, expiry)`, with the
driver limitations that implies: `LocalDriver.temporaryUrl()` returns a
plain public URL (not actually private), and R2 requires `presign`
credentials. Enable `delivery` to close both gaps.

## Lifecycle and deletion

The polymorphic `attachableType`/`attachableId` pair cannot carry a foreign
key, so **no database cascade is possible**. Deletion is explicit:

```ts
async destroy() {
  const { id } = this.validateParams(PostIdParamSchema)
  await Post.purgeAttachments(id)   // objects first, rows after
  await Post.delete({ id })
  return this.redirect('/posts')
}
```

- `detach`/`purgeAttachments` delete storage objects first (one prefix per
  attachment), then the rows. A crash between the two leaves a row pointing
  at nothing — which the next render surfaces loudly — rather than
  invisible orphaned objects.
- Model delete hooks are *not* used as the purge mechanism: they only fire
  on one of the delete paths and receive the where clause, not the row.
  Call `purgeAttachments()` explicitly in destroy actions.
- With `SoftDeletes`, soft-deleting a record leaves its attachments in
  place (restore must work); call `purgeAttachments()` on `forceDelete`
  paths.

### Sweeping orphans: `attachments:prune`

The contract is explicit-plus-sweep: whatever slips past the explicit purge
— records deleted through paths that never called `purgeAttachments()`,
storage prefixes left behind by crashed or raced jobs — is reclaimed by the
`AttachmentsPruneCommand` sweeper. Register it in the console kernel:

```ts
// src/console.ts
import { AttachmentsPruneCommand } from '@guren/core'
kernel.register(AttachmentsPruneCommand)
```

```bash
bunx guren attachments:prune             # remove rows whose record no longer exists
bunx guren attachments:prune --objects   # also remove attachments/ prefixes no row references
bunx guren attachments:prune --dry-run   # report without deleting
```

Orphan rows are detected by resolving each `attachableType` through
`Model.morphMap` and querying for the owning records — so register every
model that declares attachments:

```ts
Model.morphMap = { Post, User }
```

The sweep deletes only on positive evidence: a type missing from the morph
map, a failing existence query, or an unlistable disk is reported and left
alone — an outage must never turn into a mass deletion. Run it from a
scheduled job or CI on whatever cadence fits the app.

### Generated types: `.guren/attachments.gen.ts`

The model itself is typed by the mixin's generics, but pages, resources, and
upload clients cannot see `typeof Post.attachments`. `guren codegen` reads
each model's `Attachable(...)` declaration and generates a cross-boundary
map (the Vite plugin regenerates it whenever a file under `app/Models/` —
or a module's — changes):

```ts
// .guren/attachments.gen.ts — generated, do not edit
export interface AttachmentsMap {
  Post: { cover: 'one'; images: 'many' }
}
export interface AttachmentVariantsMap {
  Post: { cover: 'og' | 'thumb'; images: never }
}
export type AttachableModelName = keyof AttachmentsMap
export type AttachmentName<M extends keyof AttachmentsMap> = keyof AttachmentsMap[M]
```

Apps without `Attachable` models get no file. The generator reads the
declaration statically, so one it cannot fully parse — a spread, an options
object built elsewhere — is skipped with a warning rather than emitted
partially; keep declarations inline object literals to stay in the map.

### What the agent commands verify

- `bunx guren check` validates that `configureAttachments()` binds a table
  your `db/schema.ts` actually exports — the layer takes the table untyped,
  so a renamed schema export would otherwise only fail at runtime, on the
  first attach.
- `bunx guren check` also flags models mixing in `Attachable(...)` when the
  app has no `configureAttachments()` call at all — the mixin resolves the
  layer at first use, so the missing config would otherwise only fail at
  runtime too.
- `bunx guren audit` treats uploads handed to a typed `attach()` as
  validated (the declaration-driven pipeline is the validation); an action
  that reads other body input still needs `validateBody()`.

## Testing

Use the `memory` storage driver and configure against your test database:

```ts
import { configureAttachments, StorageManager } from '@guren/core'
import { attachments } from '@/db/schema'

const storage = new StorageManager({
  default: 'media',
  disks: { media: { driver: 'memory', url: 'https://cdn.test' } },
})

configureAttachments({ table: attachments, storage: () => storage, disk: 'media' })

const record = await Post.attach(post.id, 'cover', new File([bytes], 'cover.png'))
expect(await storage.disk('media').exists(record.path)).toBe(true)
```
