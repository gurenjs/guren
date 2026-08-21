# RFC: Attachments and Image Variants (Bun-native processing)

**Author:** 7nohe
**Date:** 2026-08-21
**Status:** Draft

## Problem

Guren's storage layer is path-oriented (`storage.disk().put(path, buffer)`)
and stops there. Every app that accepts an upload writes the same code: name
the file, `put()` the bytes, remember the path in *some* column, build URLs
by hand, and delete the object manually when the row goes away. There is no
model-level notion of "a `Post` has a `cover` image and many `images`", no
thumbnail story, and no safe default pipeline for user-supplied image bytes.

### Relationship to RFC 0010

RFC 0010 (*Model Attachments*, Draft, 2026-08-15) proposed a full
ActiveStorage-shaped system for this problem: two tables
(`storage_blobs` + `storage_attachments`), an `Attachable` model mixin with
generic inference, signed proxy delivery routes, direct-to-bucket uploads,
and pluggable `sharp`/Cloudflare Images transformers. It was never accepted
or implemented.

This RFC replaces that proposal with a deliberately smaller design, for two
reasons:

1. **Bun 1.4.0 ships a native image API (`Bun.Image`).** Probed on real
   hardware on 2026-08-21 (constraints below), it covers the resize +
   re-encode + LQIP needs of a v1 without adding `sharp` (a native
   dependency with its own platform matrix) or a cloud transformer to the
   critical path. The framework already trials Bun 1.4.0 in CI (#501).
2. **RFC 0010's scope was its own blocker.** Blob deduplication, signed
   proxy routes, and presigned direct uploads are each real features, but
   none of them is required to make "attach a file to a model and get a
   thumbnail" work. This RFC ships that core; RFC 0010 remains the design
   reference for the deferred layers (its verified code constraints are
   reused below and still hold).

What is *kept* from RFC 0010 is its model-facing API: the `Attachable`
typed mixin (§3), because the declaration-on-the-model shape is what both
Rails (`has_one_attached`) and Spatie Media Library converged on, and it
is the shape Guren's static-first, compile-time-checked conventions
demand. The replacement is in everything under it: one table instead of
two, `Bun.Image` instead of `sharp`, driver URLs instead of a signed
serving route.

Status handling (PEP-style `Replaces`/`Superseded-By` pairing): while this
RFC is in discussion, RFC 0010 stays `Draft` but carries a prominent
"proposed to be superseded by RFC 0013" note, so two live drafts never
read as two viable proposals. If this RFC is accepted, RFC 0010 is marked
**Superseded by RFC 0013** in the same change — the document itself stays
in `rfcs/` as design research for the deferred layers. Those layers get
*fresh* RFCs when revived, citing both documents and revalidating their
assumptions: in particular, blob dedup cannot be implemented "from
RFC 0010" verbatim once this RFC's one-table schema ships. (`Superseded`
is added to the status vocabulary in `contributing/rfc-process.md`, which
previously ended at `Withdrawn`.)

### Verified constraints

**From the codebase** (re-verified 2026-08-21; first established in
RFC 0010):

- The ORM already has polymorphic relations: `morphMany` / `morphTo`
  (`packages/orm/src/Model.ts:1399`, `:1428`) with the
  `${morphName}Type` / `${morphName}Id` column convention, `recordType`
  being the class name via `Model.morphMap`. **This RFC requires zero ORM
  changes.**
- Controllers already expose uploads as web-standard `File`s:
  `Controller.file(name)` / `Controller.files(name)`
  (`packages/server/src/mvc/Controller.ts:211`, `:222`).
- The storage abstraction is sufficient as-is: `StorageDriver`
  (`packages/server/src/storage/types.ts:59`) provides `put`, `url`,
  `temporaryUrl`, `deleteMany`, `deleteDirectory` (`:187`), `metadata`;
  disks are resolved by name through `StorageManager`. R2 has **no
  per-object visibility** — the driver throws on `put({ visibility })`
  conflicts and visibility is per bucket
  (`packages/plugin-cloudflare/src/storage/R2Driver.ts:110-117`).
- Model delete hooks are not a reliable purge trigger: `deleting`/`deleted`
  fire only on the `Model.delete(where)` path and receive the where clause,
  not the row (RFC 0010, "Verified constraints"). Purge must be explicit or
  swept.
- Framework-owned tables ship as schema snippets, not migrations
  (`DatabaseSessionStore` precedent: table in, models out).
- `guren check`'s schema rule requires `{ withTimezone: true }` on Postgres
  timestamp columns (`packages/cli/src/schema-check.ts`).
- A bare `Attachment` export would collide with `MailAttachment` /
  `NotificationAttachment` / `SlackAttachment` vocabulary already in
  `@guren/server`; the framework exports below avoid the bare name.

**From probing `Bun.Image` on Bun 1.4.0** (2026-08-21, real hardware; these
shape the spec more than any preference does):

- **`fit` supports only `fill` and `inside`.** There is no crop
  (`cover`/`contain`-with-crop) mode. The v1 variant spec is limited to
  what exists; the schema is shaped so `fit: 'cover'` can be added without
  a breaking change if Bun grows it (or via a custom processor).
- **HEIC/AVIF support depends on OS codecs and cannot be determined up
  front.** The docs' claim "AVIF encode is M3+ only" has a measured
  counterexample (success on M2 + macOS 26). The only robust strategy is
  attempting the operation and branching on
  `error.code === 'ERR_IMAGE_FORMAT_UNSUPPORTED'`. Notably, HEIC
  *decoding* is unavailable on Linux — an upload pipeline that accepts
  HEIC in dev (macOS) silently breaks in production (Linux).
- **`metadata()` is magic-byte sniffing.** Truncated or corrupt files pass
  it; only a full decode validates the image. Dimension checks and
  decompression-bomb defense must happen at decode time, with a
  **`maxPixels` cap**.
- **Path-string input is an arbitrary-file-read primitive.** `Bun.Image`
  accepts file paths; a pipeline that ever forwards user-influenced strings
  there can be steered at local files. The framework API therefore accepts
  **bytes only** (`File` / `Blob` / `Uint8Array`) and never exposes the
  path form.
- **`placeholder()` produces a ThumbHash LQIP** (data URL) cheaply at
  decode time.

## Proposed Solution

One table, one service, one processor interface. Polymorphic linkage rides
the ORM's existing `morphMany`/`morphTo`. Image work happens behind an
`ImageProcessor` interface whose default implementation is Bun-native and
resolved only when Bun is present.

### 1. Data model

A single `attachments` table, shipped as a schema snippet per dialect
(Postgres flavour shown; the morph columns follow the ORM's
`${morphName}Type`/`${morphName}Id` convention with `morphName =
'attachable'`):

```ts
// db/schema.ts (Postgres flavour)
export const attachments = pgTable('attachments', {
  id: text('id').primaryKey(),                    // ULID: sortable, unguessable object-key prefix
  attachableType: text('attachable_type').notNull(), // model class name (Model.morphMap convention)
  attachableId: text('attachable_id').notNull(),     // text covers int and uuid PKs
  collection: text('collection').notNull().default('default'), // 'cover', 'images', ...
  disk: text('disk').notNull(),                   // StorageManager disk name
  path: text('path').notNull(),                   // object key of the original
  name: text('name').notNull(),                   // original client filename (sanitized)
  contentType: text('content_type').notNull(),
  size: integer('size').notNull(),                // bytes
  width: integer('width'),                        // null for non-images / undecoded
  height: integer('height'),
  variants: jsonb('variants').$type<Record<string, AttachmentVariantRecord>>(),
  placeholder: text('placeholder'),               // ThumbHash data URL (LQIP), images only
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('attachments_attachable_idx').on(t.attachableType, t.attachableId, t.collection)])
```

```ts
interface AttachmentVariantRecord {
  status: 'pending' | 'ready' | 'failed' | 'unavailable'
  path?: string         // object key of the generated variant (status 'ready')
  width?: number
  height?: number
  format?: 'jpeg' | 'png' | 'webp' | 'avif'
  size?: number
}
```

`attach()` seeds one entry per **declared** variant immediately —
`pending` when generation is queued, `unavailable` when the runtime has no
processor — and the generator flips it to `ready` (or `failed`). Recording
declared names, not just generated ones, is what lets §7 distinguish "not
yet generated" (fall back) from "never declared" (throw) after a reload.

Notes:

- **One table, not RFC 0010's two.** The blob/attachment split buys blob
  deduplication and N:M sharing of one upload across records — neither is a
  v1 requirement, and both cost a join on every read and a reference count
  on every delete. A future dedup layer can be added behind the same
  model API (Alternatives).
- **`variants` is a JSON column, not rows.** Variant metadata is small,
  read together with its attachment, and never queried independently. The
  record shape is versioned by the service, so adding fields (e.g. a
  future `fit: 'cover'`) is additive.
- **`placeholder`** stores the ThumbHash data URL so list pages can render
  LQIPs without touching storage.
- Timestamps are `timestamptz`, per the `guren check` schema rule.

### 2. Object key layout

Everything belonging to one attachment lives under one prefix:

```
attachments/{id}/{original filename}
attachments/{id}/variants/{name}.{ext}
```

The ULID `id` makes keys unguessable-before-insert and the prefix makes
deletion a single `disk.deleteDirectory(`attachments/${id}`)` — no key
bookkeeping beyond the row itself. Filenames are sanitized (no path
separators, RFC 5987 encoding where needed) before becoming part of a key.

### 3. Model API — declarations live on the model (typed mixin)

This is the shape both reference frameworks converged on: Rails declares
`has_one_attached :cover` as a model macro, Spatie Media Library declares
collections and conversions on the model class. Guren's equivalent —
records are plain objects, statics are the API — is RFC 0010's
`Attachable` mixin, which this RFC adopts on top of the single-table
engine:

```ts
// app/Models/Post.ts
import { Attachable, hasOneAttached, hasManyAttached } from '@guren/core'

export class Post extends Attachable(defineModel(posts), {
  cover: hasOneAttached({
    image: 'require',                          // §6: full-decode validation, 422 on non-image
    variants: { thumb: { width: 320 }, og: { width: 1200 } },
  }),
  images: hasManyAttached({ image: 'require' }),
  draftPdf: hasOneAttached(),                  // opaque bytes; width/height/placeholder null
}) {}
```

The declaration passed into the mixin is inferred as generics — the same
mechanism `defineModel(table, { fillable })` already relies on — so
collection names, one/many kinds, and variant names are all compile-time
facts. What the types enforce:

- `Post.attach(id, 'covr', file)` — error: the collection argument is
  `keyof` the declaration.
- `Post.attachmentUrl(post, 'cover', { variant: 'thumb' })` — `variant`
  accepts only the names declared on `cover`; `images` declared none, so
  any variant there is an error.
- `Post.withAttachments(records, ['cover', 'images'])` returns
  `{ cover: AttachmentData | null; images: AttachmentData[] }` —
  `hasOne` is nullable-single, `hasMany` is an array.
- Declaration keys are checked against the table's column names (the
  `RecordKey<TTable>` helper `hidden`/`visible` already use), so an
  attachment named after a real column fails to compile.

The mixin statics, all delegating to an internal engine wired by
`configureAttachments()` (a clear boot-time error if it was never called):

| Static | Purpose |
|---|---|
| `Post.attach(recordId, 'cover', source, opts?)` | `source` is bytes only (`File \| Blob \| Uint8Array`, §6). `hasOne` replaces (old row + objects purged), `hasMany` appends. `opts`: `{ name?, disk?, queued? }` — the *specs* (variants, `image`, HEIC policy) come from the declaration, not the call site. |
| `Post.detach(recordId, 'images', attachmentId?)` | Removes row + objects; the third argument is rejected on a `hasOne`. |
| `Post.withAttachments(records, names)` | Batch loader for a page of records (one indexed query per call). |
| `Post.attachmentUrl(record \| id, 'cover', { variant? })` | §7 URL rules, variant fallback included. |
| `Post.purgeAttachments(recordId)` | Explicit purge for destroy actions (§8). |

Because the declaration is a static argument in the class heritage
clause, it is **statically readable**: `model-parser.ts` already unwraps
mixins around `defineModel` (this is how `SoftDeletes` is handled), so
`guren check`, `guren context Post`, and a future
`.guren/attachments.gen.ts` can all see collections and variants without
executing app code — the property that made Guren's other surfaces
agent-checkable.

Infrastructure wiring stays in config, once per app
(`DatabaseSessionStore` precedent — the app owns the table):

```ts
// config/attachments.ts
import { configureAttachments } from '@guren/core'
import { attachments } from '@/db/schema'

export const { Attachment } = configureAttachments({
  table: attachments,
  storage: () => container.make('storage'),   // StorageManager, resolved lazily
  disk: 'media',                              // default disk for new attachments
  maxPixels: 52_000_000,                      // decode cap (decompression-bomb defense, §6)
  maxImageBytes: 50_000_000,                  // encoded-input cap before decode (Open Question 2)
  queue: () => container.make('queue'),       // optional; enables queued: true
})
```

`Attachment` is a ready-made model (`defineModel(table)` with
`morphTo('attachable', 'attachable')` pre-declared) for morph relations
and advanced queries; the app-local name lives in app namespace — the
framework itself exports no bare `Attachment` (collision constraint).

```ts
interface VariantSpec {
  width?: number
  height?: number
  fit?: 'fill' | 'inside'         // Bun.Image's actual capability; 'cover' reserved for the future
  format?: 'jpeg' | 'png' | 'webp' | 'avif'
  quality?: number
}
```

Controller usage is `this.file()` → `Post.attach()`, one call:

```ts
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

**Contained typing risk.** The mixin generics were the identified
implementation risk when RFC 0010 was drafted. Two things contain it now:
the engine underneath is plain and untyped-generic (single table, service
internals), so the mixin is a *typing facade* that can ship with the core
enforcement set (collection names, kinds, variant names) first — the
column-collision check can land as a `guren check` rule instead of a
type-level constraint if the `RecordKey` interaction fights back; and the
inference pattern (options argument inferred through the factory) is the
one `defineModel`'s typed options already proved out.

### 4. Relation integration — zero ORM changes

The table follows the morph convention, so the existing relation machinery
also works, unchanged, for apps that want the raw rows:

```ts
export class Post extends Attachable(defineModel(posts), { /* … */ }) {
  static relations = {
    attachments: Post.morphMany('attachments', Attachment, 'attachable'),
  }
}

const posts = await Post.with('attachments').get()   // eager-loads all attachments
```

`morphMany` has no per-relation `where`, so it loads *all* collections of
a record; the typed per-collection path is `Post.withAttachments()`
(§3). Adding relation-level constraints to the ORM is a general win but
explicitly out of scope here (it was RFC 0010 Open Question 1; it stays
open).

`AttachmentData` — the resource-facing shape `{ id, collection, name,
contentType, size, width, height, url, placeholder, variants: Record<string,
{ url, width, height }> }` — is exported for `JsonResource.toArray()`
usage, so `Data.Post` can carry typed attachment props into Inertia pages.
The `placeholder` data URL is included by default (it is derived from the
image the client is about to receive anyway; ~20-30 bytes of entropy, no
secret).

### 5. Image processing

```ts
export interface ImageProcessor {
  /** Full decode: validates the bytes, enforces maxPixels, reports dimensions. */
  probe(input: Uint8Array, limits: { maxPixels: number }): Promise<{
    width: number; height: number; format: string; placeholder?: string
  }>
  process(input: Uint8Array, spec: VariantSpec): Promise<{
    bytes: Uint8Array; width: number; height: number; format: string
  }>
}
```

- **`BunImageProcessor`** is the default implementation, defined and
  resolved strictly inside a `typeof Bun !== 'undefined' && 'Image' in Bun`
  guard (per `packages/server/CLAUDE.md`'s Bun-API isolation rule — the
  presence check also keeps Bun 1.3.x working, see §9). It wraps
  `Bun.Image`: decode for `probe` (sniffing via `metadata()` is *not*
  validation — truncated files pass it), `placeholder()` for the ThumbHash
  LQIP, resize + encode for `process`.
- **Unsupported formats are a runtime property, not a static one.** The
  processor treats `ERR_IMAGE_FORMAT_UNSUPPORTED` as the *only* authority
  on whether this OS can decode/encode a given format; there is no
  hardcoded format×platform matrix (measured counterexamples exist).
- **Non-Bun runtimes** (Node/Lambda via `NodeHasher`-style deployments,
  Workers) get no default processor. Behaviour is then:
  - `variants` requested + no processor → the attachment is stored, the
    variants are **skipped with a logged warning** and recorded as
    `unavailable` in the §1 status record (graceful degrade;
    `url(att, 'thumb')` falls back per §7).
  - Apps can inject any `ImageProcessor` (e.g. a sharp-backed one) via
    `configureAttachments({ processor })`. The framework ships the
    interface and the Bun default only; a `sharp` implementation is a
    documented recipe, not a dependency.
  - **Workers deployments** use `queued: true`: the Worker stores the
    original and enqueues variant generation on the Redis-backed queue
    (`@guren/server/queue`, `RedisDriver`); a separate Bun worker process
    runs the job with `BunImageProcessor`. This matches the existing
    guidance that Workers apps use Redis-backed queue stores.

### 6. Security posture

These rules exist because each one closes a measured hole:

- **Bytes only.** No API in this RFC accepts a filesystem path.
  `Bun.Image`'s path-string form is an arbitrary-file-read primitive if a
  user-influenced string ever reaches it; the service simply never calls
  it. (Adopting an object that already exists on a disk — RFC 0010's
  `{ path, disk }` source — is deferred with the rest of that scope.)
- **Validation is a full decode, but bomb defense happens before it.**
  When `image: 'require'` or `variants` are requested, the pipeline is:
  (1) reject encoded input larger than `maxImageBytes` (cheapest gate;
  pixel count and upload size defend against different attacks);
  (2) reject header-declared dimensions exceeding `maxPixels` *before*
  decoding — the decoder allocates from those dimensions, so this is the
  gate that actually prevents the allocation (sharp's `limitInputPixels`
  works the same way and documents the same trust assumption on header
  metadata); (3) full decode as the validation authority — sniffed content
  types and client-declared MIME are recorded but never trusted for the
  image/not-image decision, and a check that ran only *after* a full
  decode would be validation, not bomb protection. `maxPixels` has no
  "unlimited" setting; the config default is **52,000,000 px**. For
  calibration: sharp defaults to ~268 MP, Pillow warns at ~89 MP and hard-
  errors at ~179 MP, and phones ship optional 48 MP output (iPhone HEIF/
  ProRAW) — 52 MP admits those files while a 52 MP RGBA decode is already
  ≈ 208 MB for one pixel buffer, so admitting 100–200 MP by default would
  be unsafe on ordinary app servers. Photography/archival apps raise it
  deliberately and should isolate their image workers.
  - **Gates (1) and (2) are pure JS and run on every runtime.** Neither
    the byte cap nor the header-dimension check needs `Bun.Image`: magic
    bytes and header dimensions for the §6 inline-allowlist formats (PNG
    IHDR, JPEG SOF, GIF, WebP, AVIF/HEIC `ftyp` boxes) are parsed by a
    small dependency-free sniffer in core. So even a Workers app rejects
    **synchronously**: 413 on oversized bytes, 422 on oversized header
    dimensions, 415 on a HEIC signature (no decode needed), 422 on
    non-image magic bytes under `image: 'require'`.
  - **Only gate (3), the full decode, defers on a processor-less
    runtime.** A Workers app (or any `queued: true` attach) performs the
    decode in the queue worker, so the one class that survives synchronous
    checks — bytes whose header lies or is truncated — is detected *after*
    acceptance: the job purges the attachment and marks the §1 status
    record `failed`. Apps that want full-decode rejection in the request
    path on Workers inject an in-Worker `ImageProcessor`: the Cloudflare
    Images binding (per-transform billing) or a WASM codec build
    (photon/jSquash-class; bundle-size and CPU-time costs make it a
    documented recipe, not a default). Refusing `image: 'require'`
    uploads outright on processor-less runtimes was considered and
    rejected — it contradicts §5's graceful degrade, and the residual
    exposure (a stored-then-purged lying file) does not warrant it.
- **HEIC/HEIF input is rejected by default with 415.** Decoding works on
  macOS dev machines and fails on Linux production — the default must not
  let that skew pass silently. `accepts: { heic: 'convert' }` opts in:
  the service attempts decode-and-convert (to the variant format, or JPEG)
  and returns 415 when the runtime answers `ERR_IMAGE_FORMAT_UNSUPPORTED`.
  The same error-code branch handles AVIF encode capability.
- **`image: 'forbid' | 'allow' | 'require'`** covers the non-image cases:
  a `draftPdf` collection sets nothing and stores opaque bytes
  (`width`/`height`/`placeholder` null); an avatar sets `'require'` and
  gets 422 on non-decodable input via the existing `ValidationException`
  path.
- **Serving inherits the app's existing rules.** This RFC adds no serving
  route; public disks serve via `disk.url()` (CDN/static), private disks
  via `disk.temporaryUrl()`. The XSS-via-inline-SVG class of problems is
  therefore scoped to disks the app already serves — the docs call out
  storing user uploads on a disk that serves with correct `Content-Type`
  and `X-Content-Type-Options: nosniff` headers.

### 7. URLs, visibility, and pending variants

- `Post.attachmentUrl(record, 'cover')` → `disk.url(att.path)` on a
  **public** disk, `disk.temporaryUrl(att.path, expiry)` on a **private**
  one.
  Public/private is declared **per disk** in the attachments config
  (`disks: { media: 'public', docs: 'private' }`), not per attachment —
  this matches the one driver that cannot do per-object visibility (R2 is
  per-bucket) instead of pretending otherwise. One attachment = one disk =
  one visibility.
- `url(att, 'thumb')` for a `ready` variant serves the variant's key. For
  a variant that is **declared but not yet generated** (`pending`,
  `failed`, or `unavailable` in the §1 status record) it **falls back to
  the original's URL**: pages keep rendering, at the cost of bytes, the
  `placeholder` LQIP covers the perceived-latency gap, and a later render
  picks up the variant automatically. A variant name that was **never
  declared** throws — the status record is what makes the two cases
  distinguishable after a reload. Precedent supports the fallback:
  Rails ActiveStorage answers this with blocking generate-on-demand
  behind its serving route (structurally unavailable in v1, and a
  processor failure there is an error, not a fallback), while Spatie
  Media Library's default `getUrl()` returns a dead URL for queued
  conversions and its documented remedy, `getAvailableUrl()`, is exactly
  this fallback-to-original — v1 promotes that remedy to the default.
- Known limitations carried from RFC 0010, both consequences of deferring
  the signed proxy route (RFC 0010 §3): `LocalDriver.temporaryUrl()`
  returns a plain public URL, so "private on the local disk" is not
  actually private; and `R2Driver` can only presign when `presign`
  credentials are configured (RFC 0009 §1.2) — without them
  `temporaryUrl()` throws, so **private attachments on R2 require the
  `presign` option** until the proxy route arrives. The docs state both
  limitations plainly.

### 8. Lifecycle and deletion

- **No DB-level cascade is possible** — the polymorphic
  `attachableType`/`attachableId` pair cannot carry a foreign key. Deletion
  is explicit: `Post.purgeAttachments(id)` in the destroy action
  (rows first is wrong here — see below), plus a sweeper.
- **Order: objects are deleted via prefix, rows after.**
  `detach`/`purgeAttachments` call `disk.deleteDirectory(`attachments/${id}`)`
  then delete the row. A crash between the two leaves a row pointing at
  nothing, which the next `url()` surfaces loudly; the reverse would leave
  invisible orphaned objects that only a bucket audit finds. A sweeper
  command `attachments:prune` removes rows whose record no longer exists
  (resolving `attachableType` through `Model.morphMap`) and, with
  `--objects`, storage prefixes without a row.
- Model delete hooks are **not** used as the primary mechanism (verified
  unreliable — they fire on one of three delete paths and see only the
  where clause). A best-effort `deleting` hook may purge when the where
  clause carries the primary key, but the contract is explicit-plus-sweep.
- SoftDeletes: soft-deleting leaves attachments in place (restore must
  work); `forceDelete` paths call `purgeAttachments`.

### 9. Package placement, exports, releases

- **Code lives in `@guren/core`** (`packages/core/src/attachments/`),
  exports: `configureAttachments`, `Attachable`, `hasOneAttached`,
  `hasManyAttached`, `ImageProcessor`, `AttachmentRecord`,
  `AttachmentData`, `VariantSpec` (the engine behind the mixin statics is
  internal, not exported). Rationale
  unchanged from RFC 0010: the layer needs `@guren/orm` (`defineModel`,
  `Model.morphMap`) and `@guren/server` (storage, queue) at once, and
  `@guren/core` is the established home for exactly that glue
  (`DatabaseSessionStore`). `@guren/server` must not depend on
  `@guren/orm`, and the ORM stays storage-free.
  - Core-first consequences: these are *core-native* exports (not
    re-exports of server symbols), so they need explicit wiring in
    `packages/core/src/index.ts` and a `@guren/core` changeset — an
    addition that reaches users only via a core release, not via caret
    satisfaction.
  - `BunImageProcessor` is part of the same module, behind its runtime
    guard; no build-time split is needed because the guard settles at
    module scope.
- **Bun 1.4 is not a hard requirement.** The processor is resolved by
  feature detection (`'Image' in Bun`), so Bun 1.3.x apps keep everything
  except variant generation (skipped with the §5 warning). No `engines`
  bump; the docs state "image variants require Bun ≥ 1.4".
- **Templates and scaffolds do not adopt the API in the first release.**
  Per `.claude/rules/common-pitfalls.md`, a template using an API added in
  the same PR ships apps that only build after the next release
  (`smoke:starter:npm` is the one gate that sees it). Sequence: (1) core
  release carrying `configureAttachments`; (2) only then may
  `create-app` templates, `guren add attachments` scaffolding, or the blog
  example use it. v1 ships docs + schema snippet; a `guren add
  attachments` blueprint is follow-up CLI work.

### Implementation plan

1. **Part 1 — core:** table snippet + `configureAttachments` + the
   `Attachable` mixin with its statics
   (attach/detach/withAttachments/attachmentUrl/purgeAttachments) typed on
   the declaration (core enforcement set first: names, kinds, variant
   names) + `ImageProcessor` + `BunImageProcessor`
   (probe/process/placeholder, HEIC policy, maxPixels) + docs
   (`docs/{en,ja}/guides/attachments.md`, storage guide cross-link).
   Tests: the statics against `local`/`memory` disks, plus type-level
   tests for the declaration inference (the `defineModel` typed-options
   suite is the template); processor tests gated on `'Image' in Bun` so
   the suite stays green on Bun 1.3 CI lanes.
2. **Part 2 — queue path:** `GenerateVariantsJob`, `queued: true`, the
   pending-variant URL fallback, Workers guidance in the Cloudflare guide.
3. **Part 3 — lifecycle tooling:** `attachments:prune` console command,
   `guren audit` rule for upload routes without validation, `guren check`
   rule for a `configureAttachments()` whose table is missing from
   `db/schema.ts`.
4. **Part 4 — CLI adoption (post-release):** `guren add attachments`
   blueprint, optional `make:feature --attach`, template/example adoption
   per the §9 release ordering.

Each part is one PR referencing this RFC (`Refs: RFC 0013`); Parts 2–3 are
independent once Part 1 lands.

## Alternatives Considered

- **RFC 0010 as proposed** (two tables, signed proxy delivery, direct
  upload, `sharp`/Cloudflare transformers). Strictly more capable, and
  its design work is not wasted — this RFC adopts its `Attachable` mixin
  outright — but every additional layer (blob dedup, signed routes,
  presigned uploads) is separable from the core need and none has a user
  today; they return in the Follow-ups order.
- **A standalone `AttachmentService` as the public API** (an earlier
  revision of this draft: `attachmentService.attach({ model: Post, id },
  file, { collection: 'cover', variants })`). Smaller to implement — it
  skips the mixin generics — but it is the wrong shape three times over:
  collection names are unchecked strings (a `'covr'` typo survives to
  runtime, against the framework's compile-time-safety positioning),
  declarations scatter across call sites where `guren check`, codegen,
  and `guren context` cannot see them, and neither reference framework
  works this way (Rails: `has_one_attached :cover` on the model; Spatie:
  collections declared on the model). The service survives as the
  internal engine under the mixin statics.
- **Two tables (blob/attachment split).** Buys deduplication and sharing
  of one blob across records; costs a join per read and reference counting
  per delete. No current requirement needs it; the model API sits above
  the storage schema, so a dedup layer can be introduced later behind the
  same statics (with a migration).
- **`sharp` as the default processor.** Platform-native dependency, large
  install, and redundant on the framework's primary runtime now that
  `Bun.Image` exists. Kept as an injection point (`ImageProcessor`), not a
  dependency.
- **A hardcoded format-support matrix** ("HEIC on macOS yes, Linux no;
  AVIF encode M3+"). Measured to be wrong (AVIF encode succeeded on
  M2 + macOS 26); OS-codec dependence means the only reliable signal is
  `ERR_IMAGE_FORMAT_UNSUPPORTED` at call time.
- **Accepting `fit: 'cover'` in v1 and emulating crop** (resize with
  `fill` + manual crop math on raw pixels). `Bun.Image` exposes no
  pixel-level crop today, so emulation would mean decoding to raw and
  re-encoding through a second path — complexity in the security-critical
  pipeline for a feature Bun may ship natively. The spec's `fit` union is
  future-proofed instead.
- **Storing variants as rows** (RFC 0010 derived keys, or Rails 7
  `variant_records`). JSON on the parent row is read-cheap and
  write-rare; variants are never queried except through their attachment.
- **A new `@guren/attachments` package.** Cleaner dependency story on
  paper, but it would still depend on both `@guren/orm` and
  `@guren/server`, adds a package to the release train (plugin
  `compatibility` ranges, template dep sync), and `@guren/core` exists
  precisely to host this shape of glue.
- **Serving route with signed URLs in v1** (RFC 0010 §3). Required for
  actually-private files on `local` and R2-without-presign, but it is a
  security-sensitive surface (signature scheme, inline/attachment
  allowlists, streaming) that doubles the review area. Deferred with the
  limitation documented.

## Migration Path

Purely additive and opt-in. No existing API changes; apps adopt by adding
the `attachments` table to `db/schema.ts` and calling
`configureAttachments()`. Apps that already store object keys in columns
can migrate incrementally — the old column and an attachment row can
coexist until the app switches its reads (bulk adoption of existing
objects into attachments is deferred scope, see §6 "bytes only").

## Follow-ups (deferred scope, in intended order)

Deferring is sequencing, not abandonment. Each item below revives a
layer RFC 0010 designed, as its own RFC, revalidated against this RFC's
shipped schema:

1. **Signed delivery route** (revives RFC 0010 §3) — the first planned
   follow-up, because it closes v1's one real capability gap: private
   attachments on `local` and on R2 without `presign` (§7). The v1
   schema is deliberately sufficient for it already: the row carries
   `id`, `disk`, and `path`, so the route is "verify signature → load
   row → stream from disk", and existing attachments become
   private-capable **with no schema migration** — only the URL that
   `attachmentUrl()` hands out changes. The framework's unused
   `signUrl`/`verifySignedUrl` machinery (RFC 0010's finding) is still
   the intended signer. It is split out because it is the
   security-review-heavy surface: signature scheme, inline/attachment
   allowlists, `Content-Type` hardening, streaming.
2. **Direct upload** (revives RFC 0010 §4) — browser-to-bucket presigned
   PUT where the disk supports it; depends on the signed-id shape the
   delivery route introduces.
3. **Blob deduplication** (RFC 0010's two-table split) — the only
   follow-up that needs a migration; revisit when a real workload wants
   one upload shared across records.

## Open Questions

1. **HEIC conversion default target.** When `accepts: { heic: 'convert' }`
   succeeds, convert to JPEG always, or to the first declared variant
   format? Leaning JPEG for the stored original (predictable), variants
   follow their specs.
2. **`maxImageBytes` default.** The encoded-input cap before decode is
   settled as a mechanism (§6); is 50 MB the right number for a framework
   default? (Resolved in this draft: pending-variant URLs fall back to
   the original with per-variant status records (§7), `maxPixels`
   defaults to 52 MP (§6) — both after comparing Rails/Spatie behaviour
   and sharp/Pillow limits — and per-collection specs live on the model
   declaration (§3), which also answered the earlier presets question.)
3. **Queue worker ergonomics on Workers.** The Redis-queue + separate Bun
   worker split works today but has no scaffold; does Part 2 ship a
   `bin/queue-worker.ts` template, or is that `guren add` material?
4. **`guren context` / spec integration.** Should `spec:generate`'s ER
   view render attachment edges (it reads `db/schema.ts`, so the table
   appears already), and should `guren context <Entity>` list collections?
   The §3 declaration is statically readable via `model-parser.ts`, so a
   `.guren/attachments.gen.ts` (cross-boundary maps for pages, resources,
   and `guren check`) is mechanically feasible — Part 4 material; the
   open part is scope, not feasibility.
