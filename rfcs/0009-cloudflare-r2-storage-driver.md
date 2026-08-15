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
     bucket (§6, step 0); the ACL calls will not work either way. So the
     documented recipe is at best partially true, and it is untested — there
     is no `S3Driver` test in `packages/server/tests/storage/storage.test.ts`
     (only `LocalDriver`, `MemoryDriver`, `StorageManager`).
- **`MemoryDriver`** — loses everything between isolates.

The typical first need on Workers is public reads (images, downloads) plus an
authenticated upload path — exactly the shape the binding API serves best,
with no credentials to provision and nothing extra in the bundle.

## Verified premises (2026-08-15)

The plan below was written against the code, not the docs. Corrections to the
working assumptions the plan started from:

| Assumption | Reality in the code |
|---|---|
| `StorageDriver` has "about 20 methods" | **21**: `put`, `putFile`, `get`, `getAsString`, `exists`, `delete`, `deleteMany`, `copy`, `move`, `url`, `temporaryUrl`, `size`, `lastModified`, `metadata`, `files`, `directories`, `allFiles`, `makeDirectory`, `deleteDirectory`, `setVisibility`, `getVisibility` (`packages/server/src/storage/types.ts:59-201`). Content is `Buffer \| string`; reads return `Buffer \| null`. |
| `StorageManager.registerDriver()` is a usable extension point for third-party drivers | Only half true. `registerDriver(name, factory)` exists (`StorageManager.ts:132`), but the constructor resolves every `disks` entry **eagerly** (`registerDiskFromConfig`, `StorageManager.ts:82-94`) and throws `Unknown storage driver: r2` for a driver registered afterwards. `DriverConfig` is also a **closed** union of `'local' \| 's3' \| 'memory'` (`types.ts:293-296`), so `{ driver: 'r2' }` does not type-check. **`registerDisk(name, () => driver)` is the extension point that actually works today** (`StorageManager.ts:123`), and it is what this plan uses. |
| `S3Driver` dynamically imports `@aws-sdk/client-s3` | Correct — via `importAwsModule()` with a "Missing optional dependency" error (`S3Driver.ts:463-474`). Same pattern is reused here for `aws4fetch`. |
| The Cloudflare plugin uses a lazy `binding: () => getWorkersEnv<Env>().DB` closure | Correct (`packages/orm/src/d1.ts:6-25`, `packages/plugin-cloudflare/src/env.ts`). `getWorkersEnv()` throws before the first request; `web/app/Http/Middleware/site-analytics.ts:90-97` shows the pattern for an *optional* binding (try/catch → undefined off-Workers), and `web/config/database.ts:9-11` the `isWorkersRuntime()` switch (`navigator.userAgent === 'Cloudflare-Workers'`). |
| `cloudflarePlugin()` registers services | It does not — `register() {}` is empty and `CloudflarePluginConfig` is an empty interface "reserved for upcoming RFC 0003 parts" (`packages/plugin-cloudflare/src/index.ts`). This plan keeps it that way (§2.2). |
| `cloudflare:build` scaffolds `wrangler.jsonc` | Correct — once, `wx` flag, never overwritten; `warnMissingBuildOwnedKeys` only reports **build-owned** keys (`alias`, `define`, `migrations_dir`) (`build.ts:308-396`). |
| Workers-side R2 API | Verified against the R2 Workers API reference (fetched 2026-08-15): `head(key)`, `get(key, {onlyIf, range})` → `R2ObjectBody \| R2Object \| null`, `put(key, ReadableStream \| ArrayBuffer \| ArrayBufferView \| string \| null \| Blob, {httpMetadata, customMetadata, onlyIf, md5…})`, `delete(key \| key[])` → `void`, **max 1000 keys per call**, `list({limit ≤ 1000, prefix, cursor, delimiter, include})` → `{objects, truncated, cursor?, delimitedPrefixes}`. `R2Object` carries `key, size, etag, httpEtag, uploaded (Date), httpMetadata, customMetadata, writeHttpMetadata(headers)`. **There is no `copy` on the binding**, and no presigned-URL API. |
| Presigned URLs | Verified: generated client-side with SigV4 against `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, need an R2 API token (access key id + secret), **max expiry 7 days**. Not available from a binding. |
| Cloudflare Images binding | Verified: `env.IMAGES.input(stream).transform({width…}).output({format}).response()`; billed per unique transformation. Relevant only to RFC 0010 (variants). |

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
type-level test (`R2Driver.types.test.ts`, `const _: R2BucketLike =
{} as R2Bucket`) pins that the real `R2Bucket` satisfies it, so drift in
workers-types shows up at typecheck rather than at runtime.

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
| `deleteMany(paths)` | `bucket.delete(chunk)` per **1000-key chunk** | Returns `paths.length` (dedupe first). R2 gives no per-key result; `S3Driver` returns `Deleted.length`, which S3 also reports for missing keys, so the observable contract matches. |
| `copy(from, to)` | `get(from)` → `put(to, obj.body, { httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata })` | **No copy on the binding** — stream the body through. `obj === null` throws `File not found: ${from}` (Memory precedent). Single-`put` size limits apply (multipart is out of scope). |
| `move(from, to)` | `copy` + `delete(from)` | |
| `url(path)` | `${publicUrl}/${key}` | Throws when `publicUrl` is unset (no derivable default; fail closed rather than return a URL that 404s). No percent-encoding, matching `S3Driver.url` — noted as an Open Question. |
| `temporaryUrl(path, expiration)` | `aws4fetch` SigV4 presign against `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}` with `X-Amz-Expires` | Only when `presign` is configured; else throws *"R2 bindings cannot sign URLs. Either configure `presign: { accountId, bucket, accessKeyId, secretAccessKey }` (an R2 API token) or serve private files through a signed app route."* `aws4fetch` is an **optional** dependency loaded with the `importAwsModule`-style dynamic import (same missing-module error shape). Expiry > 7 days throws up front (R2 rejects it; the S3 driver would only find out from AWS). |
| `size` / `lastModified` | `head(key)` → `size` / `uploaded` | Throw `File not found` on `null` (S3/Memory precedent). |
| `metadata(path)` | `head(key)` → `{ path, size, lastModified: uploaded, contentType: httpMetadata?.contentType, metadata: customMetadata, visibility }` | `visibility` is the disk's configured value (§1.3). |
| `files(dir)` | `list({ prefix: `${key}/`, delimiter: '/' })`, loop on `truncated`/`cursor` | Strip prefix; drop keys ending in `/` (S3 precedent, covers `.keep`-style markers only when named so — see `makeDirectory`). |
| `directories(dir)` | same `list`, read `delimitedPrefixes` | Strip prefix and trailing `/`. |
| `allFiles(dir)` | `list({ prefix })`, paginate | Pagination is **not optional**: `S3Driver.allFiles` reads a single page (`S3Driver.ts:364-383`), which silently caps at 1000; the R2 driver loops. |
| `makeDirectory(path)` | `put(`${path}/.keep`, '')` | S3 precedent. |
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
   never needs a token. `aws4fetch` (WebCrypto-based, ~6 KB, Workers-native)
   is the signer, loaded lazily so it stays out of bundles that do not use it.
   Hand-rolling SigV4 was rejected: it is 100 lines of easy-to-get-wrong
   canonicalization for zero benefit over a 6 KB dependency.
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

This is called out as an Open Question because it is stricter than S3/Local
behave; the reasoning is fail-closed over silent no-op.

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
2. **`R2Driver` falls back to the S3 API through `aws4fetch` when the
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

### 3. Files

| Action | Path | What |
|---|---|---|
| add | `packages/plugin-cloudflare/src/storage/R2Driver.ts` | Driver, `R2DriverOptions`, `R2BucketLike` + object/list shapes, `trimSlashes`, `importOptionalModule('aws4fetch')` |
| add | `packages/plugin-cloudflare/src/storage/R2Driver.test.ts` | Unit tests against an in-memory `FakeR2Bucket` (§4.1) |
| add | `packages/plugin-cloudflare/src/storage/fake-r2-bucket.ts` | Test double implementing `R2BucketLike` with real `prefix`/`delimiter`/`cursor` semantics; also exported for app tests? — Open Question |
| add | `packages/plugin-cloudflare/src/storage/R2Driver.types.test.ts` | `R2Bucket` (workers-types) satisfies `R2BucketLike` |
| add | `packages/plugin-cloudflare/src/storage/r2-miniflare.test.ts` | Opt-in e2e (`GUREN_TEST_WRANGLER=1`) against a real local R2 (§4.2) |
| edit | `packages/plugin-cloudflare/src/index.ts` | exports |
| edit | `packages/plugin-cloudflare/package.json` | `peerDependencies: { aws4fetch: "^1" }` + `peerDependenciesMeta: { aws4fetch: { optional: true } }`; devDependency `aws4fetch` for the presign test; devDependency `miniflare` for §4.2 |
| edit | `packages/plugin-cloudflare/README.md` | "Storage (R2)" section under API |
| edit | `docs/en/guides/cloudflare.md`, `docs/ja/guides/cloudflare.md` | "Storage (R2)" section: binding, `wrangler.jsonc` snippet, `StorageProvider` switch, custom domain, `wrangler r2 object put` for one-off uploads |
| edit | `docs/en/guides/storage.md`, `docs/ja/guides/storage.md` | Replace the "Cloudflare R2 via `driver: 's3'`" recipe with the binding driver for Workers; keep the S3-API recipe only if step 0 proves it works, and say what it cannot do (ACL) |
| edit | `rfcs/0003-cloudflare-workers-plugin.md` | §6 support matrix: move storage from "unsupported" to "works via `R2Driver`"; §7: strike "R2 storage driver", point here |
| edit | `packages/cli/templates/agent/core/skills/guren-api/SKILL.md` | Storage section: mention `R2Driver` on Workers (agent harness) |
| add | `.changeset/*.md` | `@guren/plugin-cloudflare` **minor** (0.2.x → 0.3.0) |
| sibling PR | `packages/cli/src/blueprints.ts` (`storage` blueprint), `packages/server/src/storage/drivers/S3Driver.ts` | `guren add storage` scaffold reads `STORAGE_DISK` (§2.4); `S3DriverOptions.acl?: boolean` (§2.4 option 1). Neither blocks the plugin release; both touch npm-resolved packages, so they ship on the server/cli train |
| edit | `web/` | nothing required; optional: register an R2 disk for the guren.dev CMS as the in-repo dogfooding app (§4.3) |

Nothing under `packages/server`, `packages/core`, `packages/create-app`, or
`packages/cli/src` changes, so none of `audit:starter-template`,
`smoke:starter*`, `sync:template-deps` are in play. `bun run audit:docs` is
content-coupled (`scripts/smoke/docs-audit.ts`) — adding an assertion that
`cloudflare.md` names `R2Driver` is optional but cheap and keeps the docs from
drifting.

### 4. Test strategy

#### 4.1 Unit tests (always on)

`R2Driver.test.ts` mirrors the `describe` structure of the `MemoryDriver`
block in `packages/server/tests/storage/storage.test.ts` (put/get, exists,
delete, copy/move, url, size/lastModified, files/directories, visibility,
deleteDirectory) against `FakeR2Bucket`, plus the R2-specific behaviours:

- `delete` returns `false` for a missing key (head-then-delete);
- `deleteMany` with 2 500 keys issues 3 `delete` calls of 1000/1000/500;
- `allFiles` over a bucket where the fake returns `truncated: true` pages
  follows `cursor` to the end (the S3 driver's single-page bug is what this
  guards against);
- `copy` preserves `httpMetadata.contentType` and `customMetadata`;
- `url()` without `publicUrl` throws, with `publicUrl` joins the prefix;
- `temporaryUrl()` without `presign` throws with the RFC 0010 hint; with
  `presign` and a fixed `datetime` produces a URL containing
  `X-Amz-Algorithm=AWS4-HMAC-SHA256`, `X-Amz-Expires=<n>`, `X-Amz-Signature`
  (aws4fetch accepts `aws: { datetime }`, so the test is deterministic);
  expiry > 7 days throws before signing;
- `put({ visibility })` / `setVisibility` matching the disk → no-op,
  conflicting → throw naming the `visibility` option;
- `binding()` returning `undefined` throws the guidance message;
- `putFile` throws.

Mutation check before merge (per `.claude/rules` "verification must be able
to fail"): drop the cursor loop and confirm the pagination test goes red.

#### 4.2 Real-runtime test (opt-in)

Miniflare exposes a real R2 implementation to Node/Bun without HTTP:
`new Miniflare({ modules: true, script: '…', r2Buckets: ['BUCKET'] })` then
`await mf.getR2Bucket('BUCKET')` returns an `R2Bucket` backed by workerd's
local R2. `r2-miniflare.test.ts` runs the same conformance block against it,
gated behind `GUREN_TEST_WRANGLER=1` exactly like
`wrangler-migrations.test.ts` (network on first run to fetch workerd; skipped
in CI). This is what catches semantics the fake gets wrong (e.g. what `list`
returns for `prefix: 'a/'` when only `a` exists, `head` on a zero-byte
object). **To verify in step 0:** Miniflare 4 under `bun test` — if workerd
spawning misbehaves under Bun, fall back to `wrangler dev` + a temp worker
that mounts the driver behind `/put`, `/get`, … and drive it with `fetch`
(the migrations test already shells out to `bunx wrangler`).

#### 4.3 Dogfooding (a real Workers app)

The same loop RFC 0003 Part 4 ran with the guren.dev site (`web/`), which
is already deployed on Workers + D1 and is the natural in-repo candidate:

- Bucket + custom domain, `MEDIA` binding, `StorageProvider` switch as in §1.
- Seeding existing files: `bunx wrangler r2 object put <bucket>/<key>
  --file …` from a script — the driver has no filesystem access on Workers,
  and a Bun script has no binding, so initial bulk loads go through wrangler
  (or the S3 API), not the driver.
- An authenticated upload path (`this.file()` → `put(buffer, { contentType })`,
  the storage guide's existing example) exercised through `wrangler dev`, then
  production.
- Guard: a `GUREN_TEST_WRANGLER=1` run of §4.2 before the release PR.

### 5. Implementation steps

0. **Spike (½ day, before writing the driver):** against a throwaway R2
   bucket, (a) run today's `S3Driver` recipe from the storage guide and record
   whether `PutObject` with `x-amz-acl` succeeds, is ignored, or errors — this
   decides what the storage-guide edit says; (b) confirm `wrangler deploy`
   fails for a nonexistent bound bucket (decides §2.1's default); (c) confirm
   Miniflare's `getR2Bucket` works under `bun test` (decides §4.2's shape).
1. `R2Driver.ts` + `FakeR2Bucket` + unit tests. Land the driver with
   `temporaryUrl` throwing unconditionally first if the aws4fetch step slows
   review; the throw message is the contract either way.
2. `temporaryUrl` presign path + deterministic test; optional peer dep.
3. Type-level test against `@cloudflare/workers-types`.
4. Miniflare e2e (opt-in).
5. Exports, README, `docs/{en,ja}/guides/{cloudflare,storage}.md`, RFC 0003
   matrix update, harness SKILL.md line, changeset. Run `bun run
   audit:core-first` (docs must import from `@guren/core` /
   `@guren/plugin-cloudflare`, never `@guren/server`) and `bun run
   audit:docs`.
6. Release `@guren/plugin-cloudflare@0.3.0` (no other package moves).
7. Dogfooding (§4.3): bucket, domain, provider switch, seeding, upload path.
   Anything a real app needs that the driver lacks comes back here as a
   follow-up.

Steps 1–5 are one PR (`feat(plugin-cloudflare): add R2Driver`); step 6 is the
release; step 7 is app-side work.

### 6. Documentation notes

- The storage guide's "S3-Compatible Services → Cloudflare R2" block is
  currently the only R2 mention. After this RFC it should say: on Workers use
  `R2Driver` (binding, no credentials); from Bun/Lambda/Vercel the S3 API with
  an R2 token is the route, with the ACL caveat from step 0 spelled out.
- Both `en` and `ja` guides move together (a lesson recorded from earlier
  reviews: en/ja drift).
- No `packages/*` paths or RFC part numbers in user-facing docs
  (`docs/CLAUDE.md`).

## Alternatives Considered

- **Extend `S3Driver` with an "R2 mode" (skip ACL, presign via aws4fetch).**
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

1. **Strict visibility (§1.3)** — throw on a conflicting `put({ visibility })`
   is stricter than every other driver. Alternative: warn once per disk and
   proceed. Leaning throw; the guide's example would then need
   `visibility` removed from the R2 variant.
2. **`url()` encoding** — `S3Driver.url` and `LocalDriver.url` do not
   percent-encode the key. Keys with spaces or `#` produce broken URLs today
   on every driver; fixing it only in R2 would be inconsistent, fixing it
   everywhere is a server change. Proposal: match existing drivers here, open
   a separate issue.
3. **Should `FakeR2Bucket` be exported** (e.g. from
   `@guren/plugin-cloudflare/testing`) so app tests can run against R2
   semantics without Miniflare? Useful for app-level tests; adds a public
   surface to maintain. Leaning yes, as a subpath export, once the fake has
   survived §4.2 comparison.
4. **`deleteMany` return value** — `paths.length` vs. head-then-delete per key
   (N Class B ops). Leaning `paths.length`, matching what S3 observably does.
5. **Streaming reads** — an optional `getStream?(path): Promise<ReadableStream
   | null>` on `StorageDriver` would let RFC 0010's proxy route avoid
   buffering; it is an additive server change and belongs with RFC 0010, but
   the R2 driver could implement it ahead of the interface (structural
   typing). Decide when RFC 0010 lands.

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
- (f) `R2Driver` S3-API fallback via aws4fetch (§2.4 option 2) — only if
  the aws-sdk dependency proves a burden for non-Workers R2 users.
- (g) RFC 0010: attachments, signed delivery, direct upload, variants.
