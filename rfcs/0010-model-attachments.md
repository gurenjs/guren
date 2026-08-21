# RFC: Model Attachments (blobs, signed delivery, direct upload, variants)

**Author:** 7nohe
**Date:** 2026-08-15
**Status:** Superseded by RFC 0013

> **Note (2026-08-21):** Superseded by RFC 0013
> (`0013-attachments-and-image-variants.md`, accepted 2026-08-21), a
> deliberately smaller design built on Bun 1.4's native `Bun.Image` that
> adopts this document's `Attachable` mixin as its model API. This
> document stays in `rfcs/` as design research for the layers RFC 0013
> defers (signed proxy delivery, direct upload, blob deduplication), each
> of which needs a fresh RFC revalidating its assumptions against the
> one-table schema before implementation.

## Problem

Guren's storage layer is path-oriented (`storage.disk().put(path, buffer)`),
and that is all it is. Every app that lets a user upload a file writes the
same code around it — the storage guide's `UploadController` example
(`docs/en/guides/storage.md`, "Handling Form Uploads") is 30 lines that
generate a filename, `put()` the bytes, and hand the path back to the caller
to store in *some* column. What is missing is the layer above the disk:

1. **No model-level attachment.** There is no way to say "a `Post` has a
   `cover` image and many `images`", load them with the post, or swap one out.
   The ORM already has polymorphic relations (`morphMany`/`morphTo`,
   `packages/orm/src/Model.ts:1394`, `:1423`, columns `${morph}Type` /
   `${morph}Id`), so the *shape* is supported; nothing is built on it.
2. **Private files are not actually private on two of three drivers.**
   `LocalDriver.temporaryUrl()` returns the plain public URL
   (`LocalDriver.ts:145-149`), and R2 bindings cannot presign at all
   (RFC 0009 §1.2). Only S3 with credentials gives a real expiring URL. The
   framework already ships a URL signer — `signUrl`/`verifySignedUrl`
   (`packages/server/src/encryption/signed-url.ts`), HMAC over
   `pathname + sorted query`, key rotation via `AppKeyring`, purpose-scoped
   keys via `deriveAppKeyring(keyring, purpose)` — but it has **no production
   caller** (only `tests/encryption/encryption.test.ts`).
3. **Visibility cannot be enforced at the driver on R2.** RFC 0009 §1.3
   settles that the driver refuses per-object visibility it cannot enforce
   and points here: the place a "private" flag can be *enforced* is a serving
   route that checks a row before it streams bytes.
4. **Uploads have no lifecycle.** No orphan cleanup, no purge on detach, no
   checksum, no direct-to-storage upload, no image variants. Every one of
   those is a Rails ActiveStorage / Laravel Media Library table stake.

None of this is specific to one backend. The layer proposed here sits on
`StorageManager` and works against **any registered disk** — `local`, `s3`,
`memory`, RFC 0009's `r2`, or a third-party `StorageDriver` — and degrades
predictably where a driver lacks a capability (§0). R2 is the case that
exposed the gaps most sharply (no presigning, no per-object ACL), which is
why this RFC is sequenced after RFC 0009 and why the two are designed as one
system split at the driver boundary; it is not the only target.

### Verified constraints (2026-08-15, against the code)

These shape the design more than any preference does:

- **Model records are plain objects, statics are the API.** `Post.find(1)`
  returns a `PlainObject`; relations are declared with static registrars
  (`Post.morphMany('comments', Comment, 'commentable')`) plus a type-level
  `static relationTypes`. There is no instance-method surface to hang
  `post.cover.attach()` on. Mixins compose as `class Post extends
  SoftDeletes(defineModel(posts))` (`packages/orm/src/SoftDeletes.ts:62`).
- **There is no relation write API** (`attach`/`detach`/`sync` do not exist
  on `Model` or `QueryBuilder`); this layer inserts its own rows.
- **`Model.morphMap` is read off the base class** (`Model.ts:2340`:
  `const morphMap = Model.morphMap ?? {}`), i.e. one app-wide registry, and
  nested eager loading through `morphTo` throws (`Model.ts:2099-2102`).
  `loadMorphMany` stores `this.name` (the class name) as the type
  (`Model.ts:2304`) — consistent with the "never mangle class names" rule in
  `.claude/rules/common-pitfalls.md`.
- **Delete hooks are not a purge trigger.** `deleting`/`deleted` fire only on
  the `Model.delete(where)` path (`Model.ts:1820-1850`), receive the *where
  clause* rather than the deleted row (`whereData`), and do not fire from
  `QueryBuilder.delete()` or the `SoftDeletes` override
  (`SoftDeletes.ts:90`). Purge has to be explicit or swept.
- **Uploads:** `Controller.file(name)` / `Controller.files(name)`
  (`Controller.ts:189-205`) return web-standard `File`s via
  `parseBody({ all: true })`; `parseRequestPayload` (`http/request.ts:11-27`)
  collapses arrays to `value[0]`, so `validateBody` sees only the first file
  of a multi-file field. Validation rules `file()`/`image()`/`mimes()`
  (`http/validation/rules.ts:671, 712, 747`) accept a structural `FileLike`.
  There is no `UploadedFile` abstraction.
- **Signing runs on Workers today.** `MessageSigner` is `node:crypto`
  (`createHmac`, `timingSafeEqual`), and RFC 0003 §6 verified — and guren.dev
  runs in production — that session-cookie signing works under
  `nodejs_compat`, so signed delivery needs no WebCrypto reimplementation.
- **Framework-owned tables ship as schema snippets, not migrations.**
  `DatabaseSessionStore` (`packages/core/src/session-store.ts`) takes the
  Drizzle table as `unknown`, documents the column contract in JSDoc and the
  guides, and absorbs dialect variance through an option (`dataMode:
  'json' | 'text'`). `make-auth.ts` is the one generator that patches
  `db/schema.ts` per dialect (via `packages/cli/src/patch-helpers.ts`).
- **Codegen is extensible mechanically.** `.guren/*.gen.ts` generators live
  in `packages/cli/src/*-types.ts`, are orchestrated by `codegenCommand`
  (`bin.ts:912-987`), and re-run from the Vite plugin's `shouldRegenerate`
  (`packages/cli/src/vite/route-types.ts:180`). `model-parser.ts` exposes
  `findStaticClassProperty(classDecl, name)` (`:192`) — a `static
  attachments = {...}` declaration is directly readable.
- **Name collision:** `MailAttachment`, `NotificationAttachment`,
  `SlackAttachment` are already exported from `@guren/server`. This RFC does
  not export a bare `Attachment`.
- **Cloudflare Images binding** (verified): `env.IMAGES.input(stream)
  .transform({ width })...output({ format }).response()`; billed per unique
  transformation. Zone-level `/cdn-cgi/image/<options>/<path>` also exists.

## Proposed Solution

Everything lives in **`@guren/core`** under `packages/core/src/attachments/`
— it needs `@guren/orm` (`Model`) and `@guren/server` (storage, signing,
router) at once, and RFC 0003 already established `@guren/core` as the home
for exactly that kind of glue (`DatabaseSessionStore`, `DatabaseApiTokenStore`).
Cloudflare-specific pieces (the Images transformer) go to
`@guren/plugin-cloudflare`. Opt-in via `bunx guren add attachments`. Nothing
here is required to use RFC 0009's driver.

### 0. Storage-agnostic by construction

The attachment layer never touches a driver directly. It resolves a disk by
name from the app's `StorageManager` (`storage: () => container.make('storage')`,
`disk: 'media'`) and speaks only the `StorageDriver` contract
(`put`/`get`/`delete`/`deleteMany`/`exists`/`metadata`/`url`/`temporaryUrl`,
plus the two *optional* additions this RFC proposes: `getStream?` and
`temporaryUploadUrl?`). Every blob row records the `disk` it lives on, so an
app can keep avatars on `local` and videos on `s3`, or switch disks per
environment (the storage guide's existing `local` in dev / `s3` in production
split), and the same `Post.attach()` / `attachmentUrl()` calls keep working.

Where a driver lacks a capability, the layer picks the fallback below rather
than failing — the choice is made once, from a **capability probe on the
resolved disk** (`typeof disk.getStream === 'function'`, and for presigning a
try/catch around `temporaryUrl()` at configure time or a per-driver
declaration; Open Question 6), never from a driver name string, so
third-party drivers get the same treatment as built-ins:

| Feature | `local` | `s3` (AWS/MinIO/Spaces…) | `r2` (RFC 0009) | `memory` (tests) | third-party |
|---|---|---|---|---|---|
| Public blob URL (`attachmentUrl`) | `disk.url()` (`/storage/...`, via `storage:link` or a static route) | `disk.url()` (bucket/CDN URL) | `disk.url()` (custom domain / r2.dev) | `disk.url()` (`memory://`) | `disk.url()` |
| Private blob URL | signed app route, **proxy** (nothing to redirect to) | signed app route → **redirect** to `temporaryUrl()` (presigned GET), or proxy | signed app route → redirect to presigned URL **if `presign` configured**, else **proxy** through the binding | proxy | redirect if `temporaryUrl()` works, else proxy |
| Proxy body | `getStream()` if the driver adds it, else `get()` buffered | `getStream()` (SDK `Body` stream) | `getStream()` (`obj.body`) | `get()` | `getStream()` if present, else `get()` |
| Direct upload | Worker/server-mediated (multipart → `put`) | **presigned PUT** via `temporaryUploadUrl()`, or mediated | presigned PUT if `presign` configured, else mediated | mediated | presigned if `temporaryUploadUrl` present, else mediated |
| Visibility | enforced by the blob row + route (the driver's own `setVisibility` is *not* consulted) | same; the layer does not call `PutObjectAcl` | same (the driver would throw on a conflict; the layer never asks) | same | same |
| Purge | `deleteMany` | `deleteMany` (1000-key batches inside the driver) | `deleteMany` (1000-key batches) | `deleteMany` | `deleteMany` |
| Variants | `materialize` with `SharpTransformer` (Bun/Node/Lambda) | `materialize` with `SharpTransformer` | `url` (Cloudflare Image Resizing) or `materialize` with `CloudflareImagesTransformer` / any transformer | `materialize` with any transformer | `materialize` with any transformer |

Two consequences worth stating:

- **`local` gains a private-file story it never had.** Today
  `LocalDriver.temporaryUrl()` returns the plain URL; with this layer a
  private blob on the local disk is only reachable through the signed
  proxy route, in dev and in production alike.
- **`s3` keeps its presigning advantages** — redirect delivery and direct
  browser→bucket uploads — and gets the same model API, purge, and variants
  as everything else. Nothing in this RFC makes S3 users go through the
  app for bytes.

The one thing the layer does *not* abstract is filesystem ingestion:
`Post.attach(id, name, { path, disk })` adopts an object that already exists
on the disk; there is no `attachFromLocalPath` because `putFile` is
unsupported on two of the four built-in drivers (memory, r2).

### 1. Data model

Two tables, Rails-shaped, dialect snippets shipped through docs + JSDoc +
`guren add attachments` (which patches `db/schema.ts` with the
`make-auth.ts` toolkit):

```ts
// sqlite / D1 flavour (pg/mysql snippets differ only in column builders)
export const storageBlobs = sqliteTable('storage_blobs', {
  id: text('id').primaryKey(),                       // ULID: sortable, no autoincrement race on D1, and
                                                     // unguessable before a direct-upload id is signed
  key: text('key').notNull().unique(),               // object key on the disk
  disk: text('disk').notNull(),                      // StorageManager disk name
  filename: text('filename').notNull(),
  contentType: text('content_type'),
  byteSize: integer('byte_size').notNull(),
  checksum: text('checksum'),                        // base64 sha256 (Open Q. 3)
  visibility: text('visibility').notNull().default('private'), // enforced by §3, not the disk
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

export const storageAttachments = sqliteTable('storage_attachments', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),                      // 'cover', 'images'
  recordType: text('record_type').notNull(),         // model class name (morph convention)
  recordId: text('record_id').notNull(),             // text: covers int and uuid PKs
  blobId: text('blob_id').notNull().references(() => storageBlobs.id),
  position: integer('position').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => [uniqueIndex('storage_attachments_uniq').on(t.recordType, t.recordId, t.name, t.blobId)])
```

- `visibility` lives on the **blob row** — that is where §3 can enforce it,
  and it is what RFC 0009's driver refuses to fake.
- `recordType` follows the ORM's morph convention (class name), so
  `Attachment.morphTo('record', 'record')` works with the existing
  `Model.morphMap`, and `Post.morphMany('attachments', StorageAttachment,
  'record')` is a plain relation.
- Rails' third table (`variant_records`) is not adopted; variants use derived
  keys (§6).
- The `storage_` prefix keeps both tables clear of app tables and of the
  mail/notification "attachment" vocabulary already in `@guren/server`.

`configureAttachments()` follows the session-store precedent — tables in,
models out — plus the storage/signing wiring:

```ts
// config/attachments.ts
import { configureAttachments } from '@guren/core'
import { storageBlobs, storageAttachments } from '@/db/schema'

export const attachments = configureAttachments({
  tables: { blobs: storageBlobs, attachments: storageAttachments },
  storage: () => container.make('storage'),      // StorageManager, resolved lazily
  disk: 'media',                                 // default disk for new blobs
  keyring: () => deriveAppKeyring(getAppKeyringFromEnv(), 'attachments'),
  delivery: { mode: 'proxy', routePrefix: '/storage', expiresIn: 5 * 60 * 1000 },
  purge: 'inline',                               // or 'queue' → PurgeBlobJob
  jsonMode: 'json',                              // 'text' for plain-text metadata columns
})
```

### 2. Model API

The declaration is passed **into the mixin**, so the attachment names, kinds,
and variant names are inferred as generics — no `as const`, no codegen, no
static the subclass has to spell out. This is the same inference
`defineModel(table, { fillable: [...] })` already relies on for its typed
options (`Model.ts:2697`), and it composes with other mixins the way
`SoftDeletes` does:

```ts
import { Attachable, hasOneAttached, hasManyAttached } from '@guren/core'

export class Post extends Attachable(defineModel(posts), {
  cover: hasOneAttached({
    visibility: 'public',
    accepts: ['image/*'],
    maxSize: '5mb',
    variants: { thumb: { width: 320 }, og: { width: 1200, height: 630, fit: 'cover' } },
  }),
  images: hasManyAttached({ visibility: 'public', accepts: ['image/*'] }),
  draftPdf: hasOneAttached(),            // private by default, any type
}) {}

// Also legal, and equivalent:
export class Post extends SoftDeletes(Attachable(defineModel(posts), { ... })) {}
```

Signature sketch:

```ts
type AttachmentSpec<Kind extends 'one' | 'many', V extends string = never> = {
  kind: Kind; visibility: 'public' | 'private'; accepts?: string[]; maxSize?: number
  variants?: Record<V, VariantSpec>
}
declare function hasOneAttached<const V extends string = never>(o?: {...; variants?: Record<V, VariantSpec>}): AttachmentSpec<'one', V>
declare function hasManyAttached<const V extends string = never>(o?: {...}): AttachmentSpec<'many', V>

declare function Attachable<
  TBase extends typeof Model,
  const TAttachments extends Record<string, AttachmentSpec<'one' | 'many', string>>,
>(Base: TBase, attachments: TAttachments): TBase & AttachableStatic<TAttachments>
```

What the types then enforce, all at compile time:

- **Names:** `Post.attach(id, 'covr', file)` is an error; the second
  argument is `keyof TAttachments`.
- **Kinds:** `withAttachments([post], ['cover', 'images'])` returns
  `{ cover: AttachedFile | null; images: AttachedFile[] }` — `hasOne` is
  nullable-single, `hasMany` is an array; `detach(id, 'cover', attachmentId)`
  rejects the third argument on a `hasOne`.
- **Variants:** `attachmentUrl(post, 'cover', { variant: 'thumb' })` accepts
  only the names declared on `cover`; `{ variant: 'thumb' }` on `images` is
  an error because it declared none (`V = never`). Ad-hoc `{ variant: {
  width: 800 } }` remains allowed as an object.
- **Records:** `withAttachments(records, names)` requires `records` to be
  `TBase`'s record type, so passing a `User[]` to `Post.withAttachments` is
  an error.
- **Attribute collision:** `TAttachments` keys are checked against the
  table's column names (`RecordKey<TTable>` — the same helper `hidden`/
  `visible` use), so an attachment named `title` on a table with a `title`
  column fails to compile instead of shadowing the column at load time.

The runtime shape is `static attachments` on the anonymous subclass, which is
what codegen and `guren check` read. The mixin's statics, all keyed on
`keyof TAttachments`:

| Static | Purpose |
|---|---|
| `Post.attach(recordId, 'cover', source, opts?)` | `source`: `File`, `Blob`, `Buffer`, `{ path, disk }` for an already-stored key, or a **signed blob id** from §4. `hasOne` replaces (old blob purged per §5), `hasMany` appends. Inserts blob + attachment rows and `put()`s the bytes. |
| `Post.detach(recordId, 'images', attachmentId?)` | Removes the attachment row; purges the blob if it has no other attachments. |
| `Post.withAttachments(records, ['cover', 'images'])` | Batch-loads attachments + blobs for a page of records (`recordType` = class name, `recordId IN (...)`, `name IN (...)`), returning records with `cover: AttachedFile \| null`, `images: AttachedFile[]`. This is the v1 eager-load story; `Post.with('cover')` integration is Open Question 1. |
| `Post.attachmentUrl(record \| recordId, 'cover', { variant?, expiresIn? })` | Public blob → `disk.url(key)`; private → signed §3 URL. |
| `Post.purgeAttachments(recordId)` | Explicit purge for record deletion (hooks are not a reliable trigger — see constraints). |

**Why not `defineModel(posts, { attachments: {...} })`?** It would infer
just as well, but `defineModel` lives in `@guren/orm`, which must not know
about storage or signing (`packages/orm/CLAUDE.md`: no `@guren/server`
imports); the mixin keeps the ORM ignorant and lets `@guren/core` own the
feature, exactly as `DatabaseSessionStore` does. Recorded as Alternatives.

`AttachedFile` (the resource-facing shape, also the `Data.*` type in
resources) is `{ id, name, filename, contentType, byteSize, checksum,
visibility, url, variants?: Record<string, string> }`. Not named
`Attachment` (collision).

**Codegen (`.guren/attachments.gen.ts`)** is where cross-boundary typing
comes from — the model itself is typed by `this`, but pages, resources, the
API client, and `guren check` cannot see `typeof Post.attachments`:

```ts
// Generated by `guren codegen` — DO NOT EDIT
export interface AttachmentsMap {
  Post: { cover: 'one'; images: 'many'; draftPdf: 'one' }
}
export type AttachmentName<M extends keyof AttachmentsMap> = keyof AttachmentsMap[M]
```

Generator `packages/cli/src/attachments-types.ts` (shape of `data-types.ts`,
discovery via `discoverParsedModels()`; the declaration is the second
argument of the `Attachable(...)` call in the class's heritage clause, which
`model-parser.ts` already walks to unwrap mixins around `defineModel`
(`findDefineModelCall`, `:234`) — a `findMixinCall(classDecl, 'Attachable')`
sibling reads it; conservative "unreadable ⇒ skip with warning" like the rest
of the parser); wired into `codegenCommand` and into `shouldRegenerate`
for `app/Models/**` and `modules/*/app/Models/**`. Consumers: the direct-upload
client (§4) types its `{ model, name }` pair; `guren check` reports models
that declare attachments in an app with no `configureAttachments()`;
`spec:generate`'s ER/domain views render attachment edges; `guren context
Post` lists them.

### 3. Signed delivery routes — private files on every driver

`registerAttachmentRoutes(router, attachments)` mounts, under
`delivery.routePrefix`:

| Route | Behaviour |
|---|---|
| `GET /storage/blobs/:signedId/:filename` | Verify with `verifySignedUrl` (purpose-scoped keyring, `requireExpiration: true`); resolve blob; **redirect mode**: 302 to `disk.temporaryUrl(key, exp)` when the disk can sign (S3, R2 with `presign`), else to `disk.url(key)` for public blobs; **proxy mode**: stream the object with `Content-Type`, `Content-Disposition`, `ETag`, `Cache-Control: private, max-age=<remaining>`. |
| `GET /storage/variants/:signedId/:filename` | §6 — same verification, then serve (or lazily materialize) the variant. |

Rules that make this the security boundary the driver cannot be:

- **The signed URL is the temporary URL, on every driver.** A private
  blob's URL is always `signUrl('/storage/blobs/<id>/<filename>', keyring,
  { expiresIn })`. What happens *behind* the signature is the per-driver
  choice from §0: redirect to a presigned URL where the disk can produce one
  (S3, R2 with `presign`), otherwise proxy the bytes (local, memory, R2 via
  the binding). Local disks, whose `temporaryUrl()` is not a signature at
  all, and R2 bindings, which cannot presign, both become private-capable
  through the same route; S3 apps keep redirecting to the bucket. This is
  why RFC 0009 could refuse to fake presigning: the two RFCs are one design
  split at the driver boundary.
- **Public blobs never touch the route.** `attachmentUrl()` returns
  `disk.url(key)` for `visibility: 'public'` — CDN-cacheable, zero app CPU,
  on any driver that has a public base URL.
- **Signature payload** = `{ blobId, disposition, variant? }` via
  `MessageSigner` claims (`iat`, `exp`, `purpose: 'attachments'`); the
  keyring is `deriveAppKeyring(root, 'attachments')` so a leaked signed URL
  key cannot forge sessions and vice-versa. `filename` is not signed and is
  only used for `Content-Disposition` (Rails does the same); it is
  sanitized (`filename*` RFC 5987 encoding, no path separators).
- **Inline vs. attachment.** Inline only for an allowlist (`image/png`,
  `image/jpeg`, `image/gif`, `image/webp`, `image/avif`, `application/pdf`,
  `video/mp4`, `audio/mpeg`, `text/plain`); everything else — notably
  `image/svg+xml` and `text/html` — is forced to `attachment` with
  `X-Content-Type-Options: nosniff`, so a user upload cannot become a
  same-origin script. Overridable per attachment declaration.
- **Streaming.** Proxy mode uses `disk.getStream(key)` when the driver
  implements it. This RFC owns that addition: an optional
  `getStream?(path): Promise<ReadableStream | null>` on `StorageDriver`
  (§8), which `R2Driver` satisfies with `obj.body`. Where it is absent the
  route falls back to `disk.get()` (buffered). Range requests are out of
  scope for v1 (Open Question 3).
- **Auth.** The signature *is* the authorization for private blobs (a
  short-lived capability URL). The alternative — an `authorize(blob, ctx)`
  callback on `registerAttachmentRoutes` for revocable access — is not in
  v1: apps that need per-request checks wrap `attachmentUrl()` in their own
  controller and set `expiresIn` low. Revisit if that wrapper turns out to
  be the common case rather than the exception.

### 4. Direct upload

Two shapes, chosen by disk capability, both behind one endpoint:

```
POST /storage/direct-uploads      (registered by registerAttachmentRoutes; must be behind app auth — see below)
```

- **App-mediated (default; works on every driver).** Multipart `file` (+ `model`, `name`
  typed via `AttachmentsMap`). The route validates with the existing
  `file()`/`image()` rules against the declaration's `accepts`/`maxSize`,
  computes the checksum server-side, creates the blob row, `put()`s the
  bytes, and returns `{ signedId, attachedFile }`. The form then submits
  `signedId` and the controller calls `Post.attach(id, 'cover', signedId)`
  — a signed id is a `MessageSigner` token over `{ blobId }` with purpose
  `'attachments:direct-upload'` and a short expiry, so a client cannot
  attach an arbitrary blob. This is the path for `local`, `memory`, and R2
  without credentials; the request body limit is whatever the runtime
  imposes (Workers: 100 MB Free / 500 MB Paid), documented.
- **Presigned (S3, or R2 with `presign`).** JSON `{ filename, contentType,
  byteSize, checksum }` → returns `{ signedId, uploadUrl, headers }`; the
  client `PUT`s the bytes straight to the bucket, then submits `signedId`.
  This needs an additive, optional driver method
  `temporaryUploadUrl?(path, expiration, { contentType, checksum })` —
  `S3Driver` via `PutObjectCommand` + presigner, `R2Driver` via the WebCrypto
  signer RFC 0009 §1.2 added (a `PUT` variant of the same shape) — and a **blob "pending" state**: the row is created before the
  bytes exist, and `attach(signedId)` verifies `disk.exists(key)` (and the
  size/checksum via `head`) before flipping it to attached.
- **Auth is mandatory and app-owned.** `registerAttachmentRoutes` requires
  `directUpload: { middleware: [...] }` (e.g. the app's `auth` alias); the
  RFC does not ship an unauthenticated upload endpoint, and `guren audit`
  should flag a direct-upload route with no auth middleware the same way it
  flags mutating routes today.
- **Orphans.** Blobs uploaded but never attached are swept by
  `attachments:purge-unattached --older-than 24h` (console command; a Job
  on runtimes with a queue worker; a Cron Trigger on Workers once RFC 0003
  §7's scheduled export exists — until then, run it from CI or `wrangler`
  manually).
- **Client helper** (`@guren/inertia-client`): `useDirectUpload({ model,
  name })` returning `{ upload(file) → signedId, progress }`, typed by
  `AttachmentsMap`. Ships with Part 2, since Part 5 dogfoods an upload UI on
  it.

### 5. Lifecycle and purge

- `attach` on `hasOne` replaces: new blob committed, then old attachment
  removed and old blob purged (if unreferenced). Order: write-then-purge, so
  a failed put never leaves the record without a cover.
- `detach` / `purgeAttachments` delete rows first, then storage objects
  (`disk.deleteMany`, chunked by the driver). A storage failure after the
  row delete leaves an orphan object, not a dangling row — the sweeper
  `attachments:purge-orphans` reconciles by listing under the blob key
  prefix. The reverse order would leave rows pointing at nothing, which
  breaks pages.
- Record deletion: **explicit** `Post.purgeAttachments(id)` in the destroy
  action (documented in the guide, scaffolded by `make:feature --attach`?
  — Open Question 4). A `deleting` hook is registered too, but only as a
  best-effort: it fires on one of three delete paths and receives the
  where clause, so it purges only when `where` carries the primary key.
  `attachments:purge-orphans` also removes attachment rows whose record no
  longer exists (resolving `recordType` through `Model.morphMap`).
- `purge: 'queue'` dispatches `PurgeBlobJob` instead of deleting inline —
  for Bun/Lambda where a queue worker exists; Workers stays inline.
- SoftDeletes: soft-deleting a record leaves attachments untouched
  (restore must work); `forceDelete` paths call `purgeAttachments`.

### 6. Variants (pluggable transformers)

```ts
export interface ImageTransformer {
  supports(contentType: string): boolean
  transform(
    input: ReadableStream<Uint8Array> | Uint8Array,
    spec: VariantSpec,                                    // { width?, height?, fit?, format?, quality? }
  ): Promise<{ body: ReadableStream<Uint8Array> | Uint8Array; contentType: string }>
}
```

Declared per attachment (`variants: { thumb: { width: 320 } }`) or ad hoc
(`attachmentUrl(post, 'cover', { variant: { width: 800 } })`); named specs
are what codegen can type. Two delivery strategies, chosen by
`variants.mode`:

- **`materialize` (default off-Workers).** `/storage/variants/:signedId/…`
  transforms on first request and stores the result under a derived key
  `variants/<blob.key>/<sha256(spec)>.<ext>` on the same disk; later hits
  `head()` and serve. No `variant_records` table — the key is the record.
  Transformers: `SharpTransformer` (optional `sharp` dep, Bun/Node/Lambda;
  **not Workers**), and `CloudflareImagesTransformer` in
  `@guren/plugin-cloudflare` (the `IMAGES` binding, verified API; billed per
  unique transformation, so materializing keeps repeat cost at zero).
- **`url` (default on Workers with a custom domain).** No transform in the
  app: `attachmentUrl()` returns
  `https://media.example.com/cdn-cgi/image/width=320,format=auto/<key>` —
  Cloudflare's zone-level Image Resizing does the work at the edge, only
  for public blobs (private ones fall back to `materialize`). Zero CPU in
  the Worker; the right default for image-heavy public sites on Cloudflare.
  Nothing Cloudflare-specific leaks into the interface: `url` mode is a
  `UrlTransformer` (`variantUrl(publicUrl, spec) → string`) that any CDN
  with URL-based resizing (imgix, Cloudinary fetch URLs, Fastly IO) can
  implement.

The transformer interface deliberately takes a stream so a Worker never
buffers a 20 MB original.

### 7. CLI, docs, harness

- `bunx guren add attachments`: patches `db/schema.ts` (per dialect,
  `patch-helpers.ts`), writes `config/attachments.ts` and
  `app/Providers/AttachmentsProvider.ts` (which calls
  `registerAttachmentRoutes`), wires the provider (`wireProviders`, as the
  `storage` blueprint does in `blueprints.ts`), prints the `guren db:make`
  step. `--module <name>` for RFC 0002 modules.
- `make:feature Post --fields ... --attach cover:one,images:many` (Open
  Question 8).
- `guren check`: models declaring `attachments` without
  `configureAttachments()`; a `configureAttachments()` whose tables are
  missing from `db/schema.ts`.
- `guren audit`: unauthenticated direct-upload route.
- Docs: `docs/{en,ja}/guides/attachments.md`; storage guide cross-link;
  Cloudflare guide "Storage (R2)" section gains an "Attachments on Workers"
  subsection (proxy mode, `url` variants, body limits).
- Harness: `guren-api` SKILL storage section + a rule line; the RFC 0008
  targets get it through the shared canonical content.

### 8. Where the pieces land

| Package | Adds |
|---|---|
| `@guren/core` | `packages/core/src/attachments/{index,configure,attachable,models,routes,signed-ids,purge,variants,transformers/sharp}.ts`; exports `configureAttachments`, `Attachable`, `hasOneAttached`, `hasManyAttached`, `registerAttachmentRoutes`, `AttachedFile`, `ImageTransformer`, `PurgeBlobJob` |
| `@guren/server` | additive optional `StorageDriver.getStream?` and `temporaryUploadUrl?`; `S3Driver` implements both |
| `@guren/plugin-cloudflare` | `R2Driver.getStream`, `R2Driver.temporaryUploadUrl` (presign only), `CloudflareImagesTransformer` |
| `@guren/cli` | `add attachments` blueprint, `attachments-types.ts` codegen, `check`/`audit` rules, `spec:generate` edges, `shouldRegenerate` |
| `@guren/inertia-client` | `useDirectUpload` (Part 2) |

Release order (per `.claude/rules/common-pitfalls.md`, templates and plugins
resolve `@guren/*` from npm): server/core additive methods → cli → plugin
uses `getStream`. The plugin's `compatibility` range must still admit the
core line that carries `configureAttachments`.

### Implementation plan

1. **Part 1 — core:** tables + `configureAttachments` + `Attachable`
   (`attach`/`detach`/`withAttachments`/`attachmentUrl`/`purgeAttachments`)
   + signed delivery routes (proxy + redirect) + `guren add attachments` +
   docs. Verified against `local`, `memory`, `s3` (MinIO in CI or the
   opt-in live test) and `r2` (RFC 0009's Miniflare harness) from day one,
   so the §0 matrix is a test table, not a promise.
2. **Part 2 — direct upload:** app-mediated endpoint + signed ids +
   orphan sweeper; presigned variant with `temporaryUploadUrl` on S3 and
   R2(+presign); `audit` rule.
3. **Part 3 — variants:** `ImageTransformer`, `materialize`/`url` modes,
   `SharpTransformer`, `CloudflareImagesTransformer`.
4. **Part 4 — tooling:** `attachments.gen.ts` codegen, `check` rules,
   `spec:generate` edges, `guren context <Entity>` listing, harness content.
5. **Part 5 — dogfooding + hardening:** a real app's upload UI on
   `useDirectUpload` (the guren.dev CMS in `web/` is the in-repo
   candidate), Range support if needed, `make:feature --attach`.

Each part is one PR referencing this RFC; Parts 2–4 are independent of each
other once Part 1 lands.

## Alternatives Considered

- **Keep the status quo (path-oriented storage + a column).** Zero new
  surface, but every app rewrites upload/URL/purge, private files stay
  unprotected on local and R2, and visibility is a lie on R2.
- **Make it R2/Workers-only (ship it inside `@guren/plugin-cloudflare`).**
  Would avoid the `@guren/core` release, but every mechanism here (rows,
  signed routes, purge, variants) is driver-independent, and local dev needs
  it as much as production does; a Cloudflare-only attachment layer would
  force apps to write a second one for `bun run dev`.
- **Presign everything, no app-served route.** Impossible on R2 bindings
  without a token, and `LocalDriver` has nothing to presign; a serving route
  is required anyway for local dev, so it becomes the common path.
- **Instance-method API (`post.cover.attach(file)`).** Reads well but
  Guren records are plain objects; the whole ORM is static-first
  (`Post.where()`, `Post.morphMany()`), and an instance wrapper would be the
  first of its kind. Statics keyed on `keyof This['attachments']` give the
  same type safety.
- **Codegen as the *only* typing mechanism.** Rejected: generic inference on
  the mixin argument works without a build step; codegen is kept for what
  only it can do (cross-boundary maps, check/spec).
- **`static attachments = {...} as const` on the subclass** (the first
  draft). Infers too, but needs `as const`, cannot check attachment names
  against table columns, and lets a subclass forget the static entirely
  while still extending `Attachable`. Passing the declaration to the mixin
  removes all three.
- **`defineModel(posts, { attachments })`.** Best ergonomics, but puts a
  storage concept into `@guren/orm`, which is kept free of server
  dependencies by design.
- **Put it in `@guren/orm`.** It needs storage, signing, and a router;
  RFC 0003 already made the call that such glue lives in `@guren/core`.
- **A `variant_records` table (Rails 7).** Derived keys + `head()` are
  enough, and it is one fewer table users must add to `db/schema.ts`.
- **Visibility in driver `customMetadata`.** Rejected in RFC 0009 §1.3 — a
  convention the bucket does not enforce.
- **Purge purely via model hooks.** Verified unreliable (see constraints);
  hooks are best-effort, explicit + sweeper is the contract.

## Migration Path

Additive and opt-in (`guren add attachments`). Apps that already store keys
in a column can backfill with `Post.attach(id, 'cover', { path: row.coverKey,
disk: 'media' })` — no re-upload. No deprecations; the storage API is
unchanged.

## Follow-ups (not in this RFC)

- **`parseRequestPayload` collapses arrays** (`http/request.ts`), so a
  multi-file field reaches `validateBody` as its first file only. This RFC
  routes around it with `this.files()`; changing the payload shape is a
  server behaviour change with its own blast radius and belongs in its own
  PR.
- **A cross-driver `StorageDriver` conformance suite** (local/memory/s3/r2),
  which §0's matrix currently asserts per-driver.

## Open Questions

1. **Eager loading:** `Post.with('cover')` needs a per-name filter on
   `morphMany` (a `where` on the relation definition) that `@guren/orm` does
   not have; v1 ships `withAttachments()` instead. Add relation constraints
   to the ORM (general win) or keep the helper?
2. **Checksum:** base64 SHA-256 (WebCrypto everywhere, R2 `sha256` put
   option) vs. base64 MD5 (Rails/S3 `Content-MD5` compatible). Leaning
   SHA-256.
3. **Range requests** in proxy mode (video): v1 or later? R2 `get(key, {
   range })` supports it; the driver's `getStream` would need a range
   argument.
4. **`make:feature --attach`** and whether `make:feature`'s destroy action
   should call `purgeAttachments` by default.
5. **Modules (RFC 0002):** a module's model declaring attachments —
    `guren add attachments --module` scaffolds module-local tables, or all
    modules share the app-level pair? Leaning shared (one `configureAttachments`
    per app), matching the sessions table.
6. **Capability detection (§0):**
7. **Variant mode default (§6):** `materialize` off-Workers and `url` on
    Workers-with-a-custom-domain — but nothing says how that is selected.
    Same class as the question above; fold it into whichever answer wins
    there, or require `variants.mode` explicitly. optional methods (`getStream?`,
    `temporaryUploadUrl?`) are probed structurally, but "can `temporaryUrl()`
    produce a real signed URL" is not observable from the type — `LocalDriver`
    returns a plain URL, `R2Driver` throws without `presign`. Options: (a) an
    optional `capabilities?: { presign: boolean }` on `StorageDriver`
    (additive, drivers opt in; unknown ⇒ proxy); (b) `delivery.mode` set
    explicitly per disk in `configureAttachments`; (c) probe once at
    configure time by calling `temporaryUrl()` on a sentinel key inside
    try/catch. Leaning (a) + (b) as an override; (c) does I/O at boot on
    S3.
