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

If this RFC is accepted, RFC 0010 should be marked **Superseded** with a
pointer here.

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
  path: string          // object key of the generated variant
  width: number
  height: number
  format: 'jpeg' | 'png' | 'webp' | 'avif'
  size: number
}
```

Notes:

- **One table, not RFC 0010's two.** The blob/attachment split buys blob
  deduplication and N:M sharing of one upload across records — neither is a
  v1 requirement, and both cost a join on every read and a reference count
  on every delete. A future dedup layer can be added behind the same
  service API (Alternatives).
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

### 3. Service API

```ts
// config/attachments.ts
import { configureAttachments } from '@guren/core'
import { attachments } from '@/db/schema'

export const { attachmentService, Attachment } = configureAttachments({
  table: attachments,
  storage: () => container.make('storage'),   // StorageManager, resolved lazily
  disk: 'media',                              // default disk for new attachments
  maxPixels: 24_000_000,                      // decode cap (decompression-bomb defense)
  queue: () => container.make('queue'),       // optional; enables queued: true
})
```

`configureAttachments` follows the `DatabaseSessionStore` precedent: the
app owns the table, the framework returns the service and a ready-made
model class (`Attachment = defineModel(table)` with `morphTo('attachable',
'attachable')` pre-declared). The app-local name `Attachment` lives in app
namespace; the framework itself exports no bare `Attachment`.

```ts
interface AttachmentService {
  attach(
    model: { constructor: typeof Model } | ModelRef,   // record + class, or (Model, id) pair
    source: File | Blob | Uint8Array,                  // bytes only — never a path string
    options?: {
      collection?: string          // default 'default'
      disk?: string                // default from config
      name?: string                // override stored filename
      variants?: Record<string, VariantSpec>
      queued?: boolean             // generate variants via the queue (default false)
      image?: 'require' | 'allow' | 'forbid'   // default 'allow' (see §6)
    },
  ): Promise<AttachmentRecord>

  for(model, collection?): Promise<AttachmentRecord[]>   // query helper (filters by collection)
  detach(attachmentId: string): Promise<void>            // row + objects
  purgeFor(model): Promise<number>                       // all attachments of one record
  url(att: AttachmentRecord, variant?: string): string | Promise<string>
}

interface VariantSpec {
  width?: number
  height?: number
  fit?: 'fill' | 'inside'         // Bun.Image's actual capability; 'cover' reserved for the future
  format?: 'jpeg' | 'png' | 'webp' | 'avif'
  quality?: number
}
```

Controller usage is `this.file()` → `attach()`, one call:

```ts
async store() {
  const data = await this.validateBody(CreatePostSchema)
  const post = await Post.create(data)
  const cover = await this.file('cover')
  if (cover) {
    await attachmentService.attach(
      { model: Post, id: post.id },
      cover,
      { collection: 'cover', variants: { thumb: { width: 320 }, og: { width: 1200 } } },
    )
  }
  return this.redirect(`/posts/${post.id}`)
}
```

### 4. Model integration — zero ORM changes

The table follows the morph convention, so the existing relation machinery
just works:

```ts
export class Post extends defineModel(posts) {
  static relations = {
    attachments: Post.morphMany('attachments', Attachment, 'attachable'),
  }
}

const posts = await Post.with('attachments').get()   // eager-loads all attachments
```

`morphMany` has no per-relation `where`, so it loads *all* collections of a
record; per-collection reads go through `attachmentService.for(post,
'cover')` (a straight indexed query). Adding relation-level constraints to
the ORM is a general win but explicitly out of scope here (it was RFC 0010
Open Question 1; it stays open).

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
    variants are **skipped with a logged warning**, `variants` stays
    empty (graceful degrade; `url(att, 'thumb')` falls back per §6).
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
- **Validation is a full decode.** When `image: 'require'` or `variants`
  are requested, `probe()` decodes under `maxPixels` before any bytes hit
  storage; sniffed content types and client-declared MIME are recorded but
  never trusted for the image/not-image decision. `maxPixels` has no
  "unlimited" setting; the config default is **24,000,000 px** (≈ a 6000×
  4000 photo; Open Question 4).
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

- `attachmentService.url(att)` → `disk.url(att.path)` on a **public**
  disk, `disk.temporaryUrl(att.path, expiry)` on a **private** one.
  Public/private is declared **per disk** in the attachments config
  (`disks: { media: 'public', docs: 'private' }`), not per attachment —
  this matches the one driver that cannot do per-object visibility (R2 is
  per-bucket) instead of pretending otherwise. One attachment = one disk =
  one visibility.
- `url(att, 'thumb')` for a variant that exists serves the variant's key.
  For a variant that is **declared but not yet generated** (queued, or
  skipped on a processor-less runtime) it **falls back to the original's
  URL**: pages keep rendering, at the cost of bytes, and the `placeholder`
  LQIP covers the perceived-latency gap. The alternative (404 or a
  blocking generate-on-demand route) is Open Question 3.
- Known limitation carried from RFC 0010: `LocalDriver.temporaryUrl()`
  returns a plain public URL, so "private on the local disk" is not
  actually private. The signed proxy route that fixes this is RFC 0010 §3
  material and stays out of v1; the docs state the limitation plainly.

### 8. Lifecycle and deletion

- **No DB-level cascade is possible** — the polymorphic
  `attachableType`/`attachableId` pair cannot carry a foreign key. Deletion
  is explicit: `attachmentService.purgeFor(model)` in the destroy action
  (rows first is wrong here — see below), plus a sweeper.
- **Order: objects are deleted via prefix, rows after.**
  `detach`/`purgeFor` call `disk.deleteDirectory(`attachments/${id}`)`
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
  work); `forceDelete` paths call `purgeFor`.

### 9. Package placement, exports, releases

- **Code lives in `@guren/core`** (`packages/core/src/attachments/`),
  exports: `configureAttachments`, `AttachmentService`, `ImageProcessor`,
  `AttachmentRecord`, `AttachmentData`, `VariantSpec`. Rationale
  unchanged from RFC 0010: the service needs `@guren/orm` (`defineModel`,
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

1. **Part 1 — core:** table snippet + `configureAttachments` +
   `AttachmentService` (attach/for/detach/purgeFor/url) + `ImageProcessor`
   + `BunImageProcessor` (probe/process/placeholder, HEIC policy,
   maxPixels) + docs (`docs/{en,ja}/guides/attachments.md`, storage guide
   cross-link). Tests: service against `local`/`memory` disks; processor
   tests gated on `'Image' in Bun` so the suite stays green on Bun 1.3
   CI lanes.
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

- **RFC 0010 as proposed** (two tables, `Attachable` mixin, signed proxy
  delivery, direct upload, `sharp`/Cloudflare transformers). Strictly more
  capable, and its design work is not wasted — but every additional layer
  (blob dedup, signed routes, presigned uploads) is separable from the
  core need and none has a user today. Shipping the small core first also
  de-risks the mixin-typing work: the service API here can later grow a
  typed mixin facade without schema changes.
- **Two tables (blob/attachment split).** Buys deduplication and sharing
  of one blob across records; costs a join per read and reference counting
  per delete. No current requirement needs it; the service API hides the
  storage schema, so a dedup layer can be introduced later behind the same
  calls (with a migration).
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

## Open Questions

1. **HEIC conversion default target.** When `accepts: { heic: 'convert' }`
   succeeds, convert to JPEG always, or to the first declared variant
   format? Leaning JPEG for the stored original (predictable), variants
   follow their specs.
2. **Per-collection config presets.** Should `configureAttachments` accept
   `collections: { cover: { variants: {...}, image: 'require' } }` so
   `attach()` calls don't repeat specs? Leaning yes but v1.x, not v1.0 —
   it is additive.
3. **Pending-variant URL semantics.** Fall back to the original (proposed:
   pages always render, bytes cost) vs. 404 vs. a blocking
   generate-on-demand route (RFC 0010 §6's `materialize`). The fallback is
   the simplest honest behaviour; generate-on-demand can arrive with the
   serving route later.
4. **`maxPixels` default.** 24 MP covers current phone cameras; is that
   the right ceiling for a framework default, and should `probe()` also
   cap *encoded* input bytes (cheaper first line) before decode?
5. **Queue worker ergonomics on Workers.** The Redis-queue + separate Bun
   worker split works today but has no scaffold; does Part 2 ship a
   `bin/queue-worker.ts` template, or is that `guren add` material?
6. **`guren context` / spec integration.** Should `spec:generate`'s ER
   view render attachment edges (it reads `db/schema.ts`, so the table
   appears already), and should `guren context <Entity>` list collections?
   Codegen (`.guren/attachments.gen.ts`) was central to RFC 0010's typed
   mixin; with a service API it is optional and deferred until the typed
   facade question returns.
