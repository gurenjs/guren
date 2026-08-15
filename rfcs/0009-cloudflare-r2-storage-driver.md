# RFC: Cloudflare R2 Storage Driver (`R2Driver` in `@guren/plugin-cloudflare`)

**Author:** 7nohe
**Date:** 2026-08-15
**Status:** Draft — implementation plan; the second half of this work (model
attachments) is RFC 0010, which builds on the driver defined here.

> RFC 0003 §7 lists "R2 storage driver" as explicitly out of scope, to be
> covered by a future RFC. This is that RFC. It is additive: no existing API
> changes, no breaking changes, and — deliberately — no change to
> `@guren/server` on the critical path (see §2.2 for why that matters for the
> release order).

## Problem

A Guren app deployed on Cloudflare Workers has no first-class way to store
files. Today's options, checked against the code:

- **`LocalDriver`** (`packages/server/src/storage/drivers/LocalDriver.ts`) —
  needs a filesystem. RFC 0003 §6 already lists it as unsupported on Workers.
- **`S3Driver`** against R2's S3-compatible endpoint — the storage guide
  (`docs/en/guides/storage.md`, "S3-Compatible Services") advertises this
  recipe today. Two problems:
  1. It needs an R2 API token (access key + secret) shipped as a Worker
     secret and pulls `@aws-sdk/client-s3` into the bundle, when the Worker
     already holds a zero-credential binding to the bucket (`env.BUCKET`).
  2. `S3Driver.put()` sends `ACL: 'public-read' | 'private'` on **every**
     `PutObjectCommand` (`S3Driver.ts:106-113`), and `setVisibility` /
     `getVisibility` issue `PutObjectAcl` / `GetObjectAcl`. R2's S3 API
     reference lists `x-amz-acl` and the ACL operations as unsupported.
     Whether R2 ignores or rejects the header must be checked against a real
     bucket (§5, step 0); the ACL calls will not work either way. So the
     documented recipe is at best partially true, and it is untested — there
     is no `S3Driver` test in `packages/server/tests/storage/storage.test.ts`
     (only `LocalDriver`, `MemoryDriver`, `StorageManager`).
- **`MemoryDriver`** — loses everything between isolates.

The typical first need on Workers is public reads (images, downloads) plus an
authenticated upload path — exactly the shape the binding API serves best,
with no credentials to provision and nothing extra in the bundle.

## Verified constraints (2026-08-15)

Read out of the code and the R2 API rather than assumed. Each one rules out a
design this plan would otherwise have reached for:

- **`StorageDriver` is 21 methods** (`storage/types.ts`); content is
  `Buffer | string`, reads return `Buffer | null`.
- **`StorageManager.registerDriver()` is not a usable extension point.** The
  constructor resolves every `disks` entry eagerly, so a driver registered
  afterwards still throws `Unknown storage driver`, and `DriverConfig` is a
  closed union of `'local' | 's3' | 'memory'`, so `{ driver: 'r2' }` does not
  type-check. **`registerDisk(name, () => driver)` is what works today**, and
  it is what this plan uses.
- **`S3Driver` loads `@aws-sdk/client-s3` through a lazy `importAwsModule()`**
  with a "Missing optional dependency" error. The plan reused that pattern for
  the presign dependency; **that was wrong on Workers** — see §1.2.
- **Bindings must be read lazily.** `createD1Database({ binding })` and
  `getWorkersEnv()` establish the contract: the resolver runs per call, and
  `getWorkersEnv()` throws before the first request. `config/database.ts` in
  the guren.dev app shows the `isWorkersRuntime()` switch
  (`navigator.userAgent === 'Cloudflare-Workers'`) that picks a driver per
  runtime.
- **`cloudflarePlugin()` registers nothing.** `register()` is empty and its
  config interface is a placeholder, so the plugin has no service-container
  seam to hang a disk on (§2.2).
- **`cloudflare:build` scaffolds `wrangler.jsonc` once** (`wx` flag, never
  overwritten) and warns only about *build-owned* keys — `alias`, `define`,
  `migrations_dir` (§2.1).
- **The R2 binding API** (verified against the Workers API reference):
  `head(key)`; `get(key, { onlyIf, range })` → `R2ObjectBody | R2Object |
  null`; `put(key, ReadableStream | ArrayBuffer | ArrayBufferView | string |
  null | Blob, { httpMetadata, customMetadata, … })`; `delete(key | key[])` →
  `void`, **max 1000 keys per call**; `list({ limit ≤ 1000, prefix, cursor,
  delimiter })` → `{ objects, truncated, cursor?, delimitedPrefixes }`.
  `R2Object` carries `key, size, uploaded, httpMetadata, customMetadata`.
  **There is no `copy` on the binding, and no presigned-URL API.**
- **Presigned URLs are a client-side SigV4 construction** against
  `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, requiring an R2 API token
  and capped at **7 days**. A binding cannot produce one.

## Proposed Solution

### 1. `R2Driver` in `@guren/plugin-cloudflare`

A `StorageDriver` implementation over the R2 **binding** (not the S3 API),
exported from the plugin package next to `createWorkersHandler` /
`getWorkersEnv`.

```ts
// packages/plugin-cloudflare/src/storage/R2Driver.ts
import type { StorageDriver, PutOptions, FileMetadata } from '@guren/core'

export interface R2DriverOptions {
  /**
   * Resolver returning the R2 bucket binding. Bindings arrive with the first
   * request on Workers, so this must be a deferred closure, e.g.
   * `binding: () => getWorkersEnv<Env>().BUCKET`. (Same contract as
   * `createD1Database({ binding })`.)
   */
  binding: () => unknown
  /**
   * Base URL for `url()`: the bucket's custom domain (recommended) or its
   * r2.dev subdomain. R2 has no derivable default — unlike S3 there is no
   * `https://<bucket>.s3.<region>.amazonaws.com` — so `url()` throws with
   * guidance when this is unset.
   */
  publicUrl?: string
  /** Key prefix, same semantics as `S3DriverOptions.prefix`. */
  prefix?: string
  /**
   * The visibility every object in this bucket effectively has. R2 has no
   * per-object ACL: a bucket is public (custom domain / r2.dev) or it is not.
   * Defaults to `'public'` when `publicUrl` is set, `'private'` otherwise.
   * See §1.3 for how put()/setVisibility() treat a conflicting request.
   */
  visibility?: 'public' | 'private'
  /**
   * S3 API credentials used only by `temporaryUrl()`. Optional — omit it and
   * `temporaryUrl()` throws with guidance (RFC 0010's signed serving route is
   * the credential-free alternative).
   */
  presign?: {
    accountId: string
    bucket: string
    accessKeyId: string
    secretAccessKey: string
  }
}

export class R2Driver implements StorageDriver { /* §1.1 */ }
```

**Structural binding type.** The driver types the binding through a local
`R2BucketLike` interface (`head/get/put/delete/list` and the object shapes it
reads), the same way `S3Driver` declares its own `S3Client { send() }`
(`S3Driver.ts:6-8`). `@cloudflare/workers-types` stays a devDependency; a
type-level test (`R2Driver.types.test.ts`) pins that the real `R2Bucket`
satisfies it, so drift in workers-types shows up at typecheck rather than at
runtime. **Learned in implementation:** streams and blobs inside that
interface must be structural too (`R2StreamLike { locked, getReader(),
cancel() }`, `R2BlobLike`), not the global `ReadableStream`/`Blob` —
workers-types declares its own interfaces for both, and neither direction is
assignable to the runtime globals, so naming the globals makes the real
`R2Bucket` fail the check while being perfectly usable at runtime.

**Registration** is through `StorageManager.registerDisk()` (the extension
point that works today, see premises), and mirrors the D1 runtime switch:

```ts
// app/Providers/StorageProvider.ts
import { ServiceProvider, createStorageManager, LocalStorageDriver } from '@guren/core'
import { R2Driver, getWorkersEnv } from '@guren/plugin-cloudflare'
import { isWorkersRuntime } from '../../config/database'

interface Env { MEDIA: unknown }

export default class StorageProvider extends ServiceProvider {
  register(): void {
    const storage = createStorageManager({ default: 'media' })
    storage.registerDisk('media', () =>
      isWorkersRuntime()
        ? new R2Driver({
            binding: () => getWorkersEnv<Env>().MEDIA,
            publicUrl: 'https://media.example.com',
          })
        : new LocalStorageDriver({ root: './storage/app/public', url: '/storage' }),
    )
    this.container.instance('storage', storage)
  }
}
```

`bun run dev` keeps writing to disk; `wrangler dev` and production hit R2.
`createStorageManager({ default: 'media' })` with no `disks` is fine: the
constructor only auto-registers a `local` disk when the default is named
`local` (`StorageManager.ts:54-56`).

#### 1.1 Method mapping

Key = `prefix ? `${prefix}/${path}` : path`, with leading/trailing slashes
trimmed as `MemoryDriver.normalizePath` does (the plugin ships its own
`trimSlashes`; `packages/server/src/support/trim-slashes` is not exported).
The binding is resolved on every call (`binding()` is a holder read, not I/O);
`null`/`undefined` throws the D1-shaped message: *"the "binding" resolver
returned no R2 bucket. On Workers this usually means it ran before the first
request — defer access (`binding: () => getWorkersEnv<Env>().BUCKET`) and check
the `r2_buckets` entry in wrangler.jsonc."*

| `StorageDriver` | R2 binding call | Notes / decision |
|---|---|---|
| `put(path, content, opts)` | `bucket.put(key, content, { httpMetadata: { contentType }, customMetadata: metadata })` | `Buffer` is a `Uint8Array` → accepted as `ArrayBufferView`; strings pass through. `opts.visibility` is checked against the disk visibility (§1.3). Returns `path`. |
| `putFile(path, localPath)` | — | **Throws** `'putFile is not supported by R2Driver: Workers has no filesystem. Read the file yourself and call put().'` Same choice as `MemoryDriver.putFile` (`MemoryDriver.ts:93-96`); RFC 0003 §6 already documents `S3Driver.putFile` as unsupported on Workers. Under `wrangler dev`, `node:fs` is a virtual fs, so "try and let it fail" would produce a confusing ENOENT. |
| `get(path)` | `bucket.get(key)` → `null` or `Buffer.from(await obj.arrayBuffer())` | Whole-object read, as the contract requires. Streaming (`obj.body`) is left to RFC 0010's proxy route via an optional driver extension. |
| `getAsString(path)` | `bucket.get(key)` → `obj.text()` | Avoids the Buffer round trip. |
| `exists(path)` | `(await bucket.head(key)) !== null` | |
| `delete(path)` | `head` then `delete` | `R2Bucket.delete()` returns `void` and is idempotent, so the contract's *"false if not found"* needs a `head` first (a Class B op — cheap). `S3Driver.delete` returns `true` unconditionally, but Local/Memory are exact; follow the exact ones. |
| `deleteMany(paths)` | `bucket.delete(chunk)` per **1000-key chunk** | Returns `paths.length` (dedupe first). R2 gives no per-key result. The alternative — head-then-delete per key, for an exact count — costs N extra reads to report something `S3Driver` does not report either: it returns `Deleted.length`, which S3 also counts for missing keys, so the observable contract already matches. |
| `copy(from, to)` | `get(from)` → `put(to, obj.body, { httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata })` | **No copy on the binding** — stream the body through. `obj === null` throws `File not found: ${from}` (Memory precedent). Single-`put` size limits apply (multipart is out of scope). |
| `move(from, to)` | `copy` + `delete(from)` | |
| `url(path)` | `${publicUrl}/${key}` | Throws when `publicUrl` is unset (no derivable default; fail closed rather than return a URL that 404s). **Amended in implementation:** percent-encodes each key segment, unlike `S3Driver.url` (Open Question 3). |
| `temporaryUrl(path, expiration)` | SigV4 presign on WebCrypto against `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}` with `X-Amz-Expires` | Only when `presign` is configured; else throws with guidance naming the option and the signed-route alternative. Expiry > 7 days throws up front (R2 rejects it; the S3 driver would only find out from AWS). **Amended in implementation:** the signer is written in-package, not taken from a dependency — see §1.2. |
| `size` / `lastModified` | `head(key)` → `size` / `uploaded` | Throw `File not found` on `null` (S3/Memory precedent). |
| `metadata(path)` | `head(key)` → `{ path, size, lastModified: uploaded, contentType: httpMetadata?.contentType, metadata: customMetadata, visibility }` | `visibility` is the disk's configured value (§1.3). |
| `files(dir)` | `list({ prefix: `${key}/`, delimiter: '/' })`, loop on `truncated`/`cursor` | Strip prefix; drop keys ending in `/` (S3 precedent, covers `.keep`-style markers only when named so — see `makeDirectory`). |
| `directories(dir)` | same `list`, read `delimitedPrefixes` | Strip prefix and trailing `/`. |
| `allFiles(dir)` | `list({ prefix })`, paginate | Pagination is **not optional**: `S3Driver.allFiles` reads a single page (`S3Driver.ts:364-383`), which silently caps at 1000; the R2 driver loops. |
| `makeDirectory(path)` | `put(`${key}/`, '')` — a zero-byte object whose key ends in `/` | **Amended in implementation** from the S3 driver's `.keep` marker: a trailing-slash key is the folder convention S3 consoles use, `directories()` sees it as a delimited prefix, and the trailing-slash filter keeps it out of `files()`/`allFiles()` — a `.keep` marker would be listed as a file, which is what `S3Driver` does today. `deleteDirectory()` deletes raw listed keys (not through `key()`, which would strip the slash). |
| `deleteDirectory(path)` | `allFiles` + `deleteMany` (chunked) | |
| `setVisibility(path, v)` | — | No per-object ACL in R2. **No-op when `v` equals the disk visibility, throws otherwise** (§1.3). |
| `getVisibility(path)` | `head` for existence, then return the disk visibility | Throws `File not found` on `null` (Memory precedent). |

#### 1.2 Design decision: `temporaryUrl`

Three options were weighed:

1. **Always throw.** Simplest, but rules out the legitimate "private bucket +
   time-limited download link" case that S3 users get for free.
2. **Presign with S3 credentials when configured, throw otherwise** —
   **chosen.** Matches how Cloudflare itself documents presigned URLs for R2
   (client-side SigV4 with an API token; not something a binding can do), and
   keeps the credential-free default: an app that never calls `temporaryUrl()`
   never needs a token.

   **The signer itself was amended twice in implementation, and the reason is
   worth recording.** The plan said: use `aws4fetch` (WebCrypto-based, ~11 KB,
   Workers-native), loaded lazily through the `importAwsModule` pattern so it
   stays out of bundles that do not use it — and rejected hand-rolling SigV4
   as "100 lines of easy-to-get-wrong canonicalization for zero benefit over a
   small dependency". Both halves turned out to be wrong:

   1. **A lazy import with a variable specifier cannot work on Workers.** No
      Workers bundler can follow `import(moduleName)`, so the presign path
      threw `No such module` at runtime while every test stayed green (under
      Bun the same import resolves from `node_modules`). This is invisible to
      any test that does not run inside workerd — see §4. A literal
      `import('aws4fetch')` bundles correctly but then fails the *build* for
      every app that never signs a URL, since an optional dependency is not
      installed.
   2. **The dependency is dormant.** Last release 2024-08, last commit
      2024-12, 22 open issues (checked 2026-08-15).

   So the driver signs with WebCrypto directly (`crypto.subtle`, a global on
   workerd, Bun and Node 18+). R2 presigning is one request shape — GET, no
   body, `host` the only signed header — which makes the canonicalization
   ~70 lines, and it leaves nothing for a bundler to resolve. The
   implementation was cross-checked byte-for-byte against `aws4fetch` on
   plain, spaced, unicode and RFC-3986-reserved keys before that package was
   removed; those signatures are frozen as known-answer tests.
3. **Sign an app route instead** (a Guren-served `/storage/<signed>` URL). This
   is the right long-term answer for *private* files and is exactly RFC 0010's
   signed delivery route — which is why the throw message here points at it.
   It is not the driver's job: `temporaryUrl()` returns a URL the app does not
   have to serve, and coupling the driver to the router would break the
   `StorageDriver` contract's independence from HTTP.

#### 1.3 Design decision: `setVisibility` / `getVisibility` / `put({ visibility })`

R2 has bucket-level public access (custom domain or the r2.dev subdomain) and
nothing per object. The candidates:

- **Silently accept and record nothing.** Rejected — `setVisibility(path,
  'private')` on a public bucket that then does nothing is a data leak that
  looks like success; the storage guide's upload example passes `visibility:
  'public'` and readers will assume it did something.
- **Record the requested value in `customMetadata` and enforce it in a serving
  route.** That is an attachment-layer concern (RFC 0010 stores visibility on
  the blob row, where it belongs). A driver that pretends to enforce a flag it
  cannot enforce would be worse than one that refuses.
- **Compare against the disk's configured visibility: equal → no-op, different
  → throw** — **chosen.** The disk declares what the bucket *is*
  (`visibility` option, defaulted from `publicUrl`), `getVisibility()` reports
  it, and any request that would require per-object ACLs fails loudly at the
  call site with a message that names the option. Portable code that never
  passes `visibility` (the common case) is unaffected.

This is stricter than S3/Local behave, and the alternative considered was to
warn once per disk and proceed; fail-closed beat silent no-op, because the
failure this prevents is a leak that looks like success.

#### 1.4 Design decision: `putFile`

Throws (see mapping). One nuance worth recording: the driver is only ever
instantiated where a binding exists (workerd under `wrangler dev`, or
production), and neither has the caller's real filesystem. There is no
half-working case to preserve.

### 2. Wiring, wrangler, and the build

#### 2.1 `wrangler.jsonc`

The binding entry the app needs:

```jsonc
"r2_buckets": [
  { "binding": "MEDIA", "bucket_name": "my-app-media" }
]
```

plus, for `publicUrl`, a custom domain attached to the bucket in the dashboard
(the r2.dev subdomain is rate-limited and meant for development).

**Decision: `cloudflare:build` does not scaffold `r2_buckets` by default.**
The existing scaffold includes `d1_databases` because every Guren app has a
database; storage is optional, and wrangler will not deploy a Worker whose
bound bucket does not exist (to be re-confirmed in step 0), so an
unconditional entry would break `wrangler deploy` for every app that never
touches storage until they hand-edit the config — the opposite of the D1
`TODO` placeholder, which only blocks apps that *do* need it. Instead:

- the docs (`cloudflare.md` → new "Storage (R2)" section) carry the snippet;
- the driver's missing-binding error prints the exact JSON entry to add;
- `warnMissingBuildOwnedKeys` is left alone — `r2_buckets` is app-owned, not
  build-owned, and that function's contract is "name what the build needs".

If real usage shows most apps want a bucket, a `--with-r2 <BINDING>` flag on
`cloudflare:build` (scaffold-time only, never rewriting an existing file) is
the additive follow-up; it is not in this RFC.

#### 2.2 Why nothing changes in `@guren/server` on the critical path

The plugin resolves `@guren/core` from npm (`^1.5.2`) for its users, and the
scaffold templates resolve `@guren/*` from npm too (`.claude/rules/common-pitfalls.md`,
"Templates vs. Published Packages"). If `R2Driver` depended on a *new* server
API (an open `DriverConfig`, lazy driver-factory resolution), the plugin
release would have to trail a server/core release, and no app could use the
driver until both shipped. Every piece of §1 uses APIs that exist in the
published `@guren/core` today: the `StorageDriver` type, `registerDisk()`,
`createStorageManager()`.

The two server-side improvements this surfaced are real, and are listed as
follow-ups (§7): (a) resolve driver factories lazily in `disk()` so
`registerDriver()` after construction works and plugins can register drivers
in `register()`; (b) an augmentable driver registry interface so
`disks: { media: { driver: 'r2', ... } }` type-checks (Hono's
`ContextVariableMap` pattern). Neither is needed to ship the driver.

#### 2.3 Plugin surface

`packages/plugin-cloudflare/src/index.ts` adds:

```ts
export { R2Driver } from './storage/R2Driver'
export type { R2DriverOptions, R2BucketLike } from './storage/R2Driver'
```

`gurenPlugin.compatibility` (`>=1.0.0 <2.0.0`) is unaffected: the driver only
consumes types and `registerDisk`, both present since 1.0.

#### 2.4 Selecting the disk by environment, and reaching R2 off Workers

Two questions come up together, so they are answered together.

**Environment-driven disk selection works today** — `createStorageManager`
already takes `default` and resolves disks lazily, so declaring every disk
and choosing with an env var is the Laravel `FILESYSTEM_DISK` shape:

```ts
// app/Providers/StorageProvider.ts
const storage = createStorageManager({
  default: process.env.STORAGE_DISK ?? 'local',
  disks: {
    local: { driver: 'local', root: './storage/app/public', url: '/storage' },
    s3:    { driver: 's3', bucket: process.env.S3_BUCKET!, region: 'ap-northeast-1' },
  },
})
storage.registerDisk('r2', () => new R2Driver({ binding: () => getWorkersEnv<Env>().MEDIA, publicUrl: process.env.MEDIA_URL }))
```

`.env` → `STORAGE_DISK=local`; `wrangler.jsonc` → `"vars": { "STORAGE_DISK":
"r2" }` (RFC 0003 §5: `nodejs_compat` populates `process.env` from `vars`
for the scaffold's compatibility date). Unused disks are never constructed,
so the `s3` entry costs nothing in dev. The `guren add storage` scaffold
should adopt this shape (`STORAGE_DISK`) so apps get the switch for free —
listed in §3. The one thing an env var cannot do is make `r2` work where the
binding does not exist, which leads to:

**R2 is reachable from anywhere; only the *binding* is Workers-only.** R2
has four access paths, and the driver above covers one:

| Path | From | Guren surface |
|---|---|---|
| Workers binding (`env.MEDIA`) | workerd only (`wrangler dev` uses a local emulated bucket; `wrangler dev --remote` the real one) | `R2Driver` (this RFC) |
| S3-compatible API + R2 API token | Bun, Node, Lambda, Vercel, scripts — anywhere with `fetch` | today's `S3Driver` with `endpoint: https://<account>.r2.cloudflarestorage.com`, `region: 'auto'` — the storage guide's existing recipe, **modulo the ACL header** (below) |
| Public bucket (custom domain / r2.dev) | any HTTP client, reads only | `publicUrl` / `disk.url()` |
| `wrangler r2 object put/get`, REST API | CLI / CI | bulk loads, migrations |

So a Bun dev server can talk to the **same** R2 bucket as production
through the S3 API. Two options for how Guren exposes that:

1. **`S3Driver` gets an `acl?: boolean` option (default `true`)** and R2/MinIO
   users set `acl: false`, which suppresses `x-amz-acl` on `PutObject` and
   makes `setVisibility`/`getVisibility` follow §1.3's rule (compare with the
   disk's `visibility`, no `PutObjectAcl`). Small, additive, in
   `@guren/server`, and needed regardless of this RFC because the current
   unconditional ACL is a latent bug for every non-AWS S3 target. **Chosen
   as a sibling PR**, not on this RFC's critical path (§2.2) — the R2Driver
   ships without it, and step 0 decides how urgent it is.
2. **`R2Driver` falls back to the S3 API through its own signer when the
   binding is absent and `presign` credentials are set** — one driver
   everywhere, no `@aws-sdk` in the bundle. Rejected for v1: `ListObjectsV2`
   and `DeleteObjects` are XML in and out, so the fallback needs an XML
   parser and serializer the plugin would then own; `S3Driver` already
   does all of it. Revisit if the aws-sdk dependency proves a real burden
   for non-Workers R2 users.

The recommended dev story therefore has two rungs, both documented in the
Cloudflare guide: `bun run dev` with `STORAGE_DISK=local` (fast loop, no
network), and either `wrangler dev` (local emulated R2, exercises the real
driver) or `STORAGE_DISK=s3` pointed at the R2 endpoint when a shared,
persistent bucket is wanted from a Bun process.

### 3. Where it lands

| Package | Change |
|---|---|
| `@guren/plugin-cloudflare` | The driver, its structural binding types, the WebCrypto signer (§1.2), and their tests; four new type exports (`R2Driver`, `R2DriverOptions`, `R2PresignOptions`, `R2BucketLike`). No runtime dependency is added |
| Docs | A "Storage (R2)" section in the Cloudflare guide (both languages); the storage guide's R2-over-S3 recipe gains the "on Workers, use the binding" pointer and the ACL caveat from step 0; RFC 0003's §6 matrix moves storage out of "unsupported" |
| Agent harness | The `guren-api` skill's storage section names `R2Driver` on Workers |
| Sibling PR (`@guren/server`, `@guren/cli`) | `S3DriverOptions.acl` and the `STORAGE_DISK` scaffold (§2.4). Neither blocks this release |

Nothing in `@guren/server`, `@guren/core`, `@guren/create-app`, or the CLI's
own source changes, so none of the template audits or starter smokes are in
play (§2.2 explains why that matters for the release order).

### 4. Test strategy

Three layers, because each catches something the one below cannot:

1. **Unit tests against an in-memory `FakeR2Bucket`** implementing
   `R2BucketLike` with real prefix/delimiter/cursor semantics. This is where
   the driver's own logic is pinned — key scoping, the 1000-key delete
   batching, cursor following (which `S3Driver.allFiles` gets wrong today by
   reading one page), folder markers, and the visibility and presign refusals.
   The fake also records calls, so "deletes each page as it lists it" is
   assertable at all.
2. **A type-level test** that the real `R2Bucket` from
   `@cloudflare/workers-types` satisfies `R2BucketLike`, so drift in
   workers-types is a typecheck failure rather than a runtime one. **Learned
   in implementation:** streams and blobs inside that interface must be
   structural too (`R2StreamLike`, `R2BlobLike`), not the global
   `ReadableStream`/`Blob` — workers-types declares its own interfaces for
   both, and neither direction is assignable to the runtime globals, so naming
   the globals makes the real `R2Bucket` fail a check it should pass.
3. **An opt-in run against workerd's real R2** through Miniflare, gated
   behind `GUREN_TEST_WRANGLER=1` exactly like `wrangler-migrations.test.ts`
   (it fetches a native binary on first run, so CI skips it). The same
   conformance suite runs against both the fake and the real bucket, so every
   semantic the fake encodes is checked against the runtime rather than
   assumed.

**Two things only layer 3 can see, and both were real.** Miniflare's binding
proxy cannot marshal a `ReadableStream`, so `copy()`/`move()` — the methods
that pipe `get().body` into `put()`, because the binding has no copy — have to
run *inside* workerd, which the suite does by bundling the driver into a
worker. And `temporaryUrl()` must sign from inside that same bundle: the first
implementation loaded its signer through a lazy import that no Workers bundler
can follow, which no test outside workerd could observe (§1.2).

Whatever a test protects, check it can fail: dropping the cursor loop must
turn the pagination test red, and restoring the lazy signer import must turn
the in-workerd presign test red.

#### 4.3 Dogfooding (a real Workers app)

The same loop RFC 0003 Part 4 ran with the guren.dev site (`web/`), which is
already deployed on Workers + D1:

- Bucket + custom domain, `MEDIA` binding, `StorageProvider` switch as in §1.
- Seeding existing files goes through `wrangler r2 object put` or the S3 API,
  not the driver: the driver has no filesystem access on Workers, and a Bun
  script has no binding.
- An authenticated upload path (`this.file()` → `put(buffer, { contentType })`)
  exercised through `wrangler dev`, then production.

### 5. Implementation plan

Split into parts, referencing this RFC:

0. **Spike.** Against a throwaway bucket, measure the two things §2.1 and §6
   currently assume: whether R2 ignores or rejects `x-amz-acl` on `PutObject`
   (which decides what the storage guide says, and how urgent the
   `S3DriverOptions.acl` sibling PR is), and whether `wrangler deploy` refuses
   a Worker bound to a bucket that does not exist (which decides the scaffold
   default). Both are Open Questions until then.
1. **Driver.** `R2Driver`, the structural binding types, `FakeR2Bucket`, the
   unit and type-level tests.
2. **Presigning.** The WebCrypto signer (§1.2) and its known-answer tests,
   plus the in-workerd presign check. The driver is useful before this lands —
   `temporaryUrl()` throwing with guidance is the contract either way.
3. **Real-runtime coverage.** The opt-in Miniflare conformance run.
4. **Docs and release.** Exports, README, both guides, the RFC 0003 matrix,
   the harness skill, changeset; `@guren/plugin-cloudflare` minor.
5. **Dogfooding** (§4.3). Anything a real app needs that the driver lacks
   comes back here as a follow-up.

### 6. Documentation notes

The storage guide's "S3-Compatible Services → Cloudflare R2" block is
currently the only R2 mention. After this RFC it says: on Workers use
`R2Driver` (binding, no credentials); from Bun/Lambda/Vercel the S3 API with
an R2 token is the route, with the ACL caveat from step 0 spelled out.

## Alternatives Considered

- **Extend `S3Driver` with an "R2 mode" (skip ACL, presign without the SDK).**
  Keeps one driver, but ships `@aws-sdk/client-s3` in the Worker and still
  needs a token for every operation when a zero-credential binding is sitting
  in `env`. Also leaves the plugin with nothing platform-specific to own. The
  S3-API path stays *documented* for non-Workers runtimes; it just is not the
  Workers driver.
- **Put `R2Driver` in `@guren/server` next to `S3Driver`.** It would sit
  behind the closed `DriverConfig` union and give `driver: 'r2'` for free, but
  it couples the core release train to Cloudflare surface (RFC 0003 chose the
  plugin for `createWorkersHandler` for the same reason) and forces the
  server-side changes of §2.2 onto the critical path.
- **Register the disk from `cloudflarePlugin({ storage: … })`.** Hides the
  runtime switch inside the plugin's `boot()` (`container.make('storage')
  .registerDisk(...)`). Rejected for now: it depends on the app's own
  `StorageProvider` having bound `'storage'` first, and the D1 precedent is
  explicit config in `config/*.ts`, not plugin magic. Revisit with §7(a) if the
  explicit form proves noisy.
- **Scaffold `r2_buckets` unconditionally in `wrangler.jsonc`.** See §2.1.
- **Implement per-object visibility by key convention (`public/…` prefix)
  or `customMetadata`.** Both are conventions the bucket does not enforce;
  RFC 0010 owns visibility at the blob row where a serving route can enforce
  it.

## Migration Path

Purely additive. Existing `S3Driver`-on-R2 users can keep the S3 API on
non-Workers runtimes; on Workers they swap `driver: 's3'` config for a
`registerDisk('…', () => new R2Driver({ binding, publicUrl }))` call and drop
the token secrets. No deprecations.

## Open Questions

1. **Does `wrangler deploy` refuse a Worker bound to a bucket that does not
   exist?** §2.1 declines to scaffold `r2_buckets` on the strength of this,
   and it is still unmeasured — if wrangler in fact deploys and only fails at
   runtime, the scaffold decision should be revisited. Step 0 measures it.
2. **What does R2 do with `x-amz-acl` on `PutObject`?** The storage guide's
   S3-API recipe and the `S3DriverOptions.acl` sibling PR (§2.4) both hinge on
   whether R2 ignores or rejects the header. Also step 0.
3. ~~**`url()` encoding**~~ — **Resolved in implementation (review
   finding):** `R2Driver.url()` percent-encodes each key segment, since this
   is the first place a Workers app is steered to a driver's `url()` for
   public links. `S3Driver.url` / `LocalDriver.url` still do not; aligning
   them is a server change tracked separately.
4. **Should `FakeR2Bucket` be exported** (e.g. from
   `@guren/plugin-cloudflare/testing`) so app tests can run against R2
   semantics without Miniflare? Useful for app-level tests; adds a public
   surface to maintain. Leaning yes, as a subpath export, once the fake has
   survived the real-runtime comparison in §4.
5. ~~**Streaming reads**~~ — **owned by RFC 0010 §3**, which proposes the
   optional `getStream?` on `StorageDriver` and consumes it; `R2Driver` will
   implement it (`obj.body`) when that lands. Not open here.

## Follow-ups (not in this RFC)

- (a) `StorageManager`: resolve driver factories lazily in `disk()` so
  `registerDriver()` after construction serves config-declared disks; error
  timing moves from construction to first use (needs a test update, not an
  API change).
- (b) Augmentable driver registry: `interface StorageDrivers { local: …; s3:
  …; memory: … }` in `@guren/server`, `DriverConfig` derived from it,
  `declare module '@guren/server' { interface StorageDrivers { r2:
  R2DriverOptions } }` in the plugin.
- (c) `S3Driver` tests — none exist; the ACL-on-R2 finding is the kind of
  thing they would have caught.
- (d) `cloudflare:build --with-r2 <BINDING>` if demand shows up.
- (e) `S3DriverOptions.acl` and the `STORAGE_DISK` scaffold (§2.4) — sibling
  PRs, tracked separately.
- (f) `R2Driver` S3-API fallback through its own signer (§2.4 option 2) — only if
  the aws-sdk dependency proves a burden for non-Workers R2 users.
- (g) RFC 0010: attachments, signed delivery, direct upload, variants.
