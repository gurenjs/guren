# RFC: Signed Attachment Delivery Route

**Author:** 7nohe
**Date:** 2026-08-26
**Status:** Accepted (2026-08-27; maintainer decision, standard two-week
discussion window deliberately compressed — solo-maintainer project)

## Problem

RFC 0013 shipped model attachments with one deliberate capability gap
(§7, restated in its Follow-ups as item 1): **a "private" attachment is
only private on disks that can presign**. The v1 URL policy is five
lines (`packages/core/src/attachments/engine.ts:1078-1084`):

```ts
private async urlFor(diskName: string, path: string): Promise<string> {
  const disk = this.storage().disk(diskName)
  if (this.visibilityOf(diskName) === 'private') {
    return disk.temporaryUrl(path, new Date(Date.now() + this.urlExpiresIn))
  }
  return disk.url(path)
}
```

Which means, per driver, today:

- **`local`** — `LocalDriver.temporaryUrl()` just returns `url()`
  (`packages/server/src/storage/drivers/LocalDriver.ts:149-153`), so a
  `private` local disk hands out plain public URLs. The attachments
  guide documents this as a known limitation
  (`docs/en/guides/attachments.md`, "URLs and visibility").
- **`r2` without `presign`** — `R2Driver.temporaryUrl()` throws
  (`packages/plugin-cloudflare/src/storage/R2Driver.ts:293-300`), and
  `url()` throws too without `publicUrl` (`:283-291`). A private R2
  disk on the binding alone cannot produce *any* URL.
- **`s3` / `r2` with `presign`** — real presigned GETs work, but the
  app has no control over `Content-Disposition`, no inline/attachment
  policy, and no single place to harden `Content-Type` handling for
  user-supplied bytes.

RFC 0010 §3 designed the missing layer — a signed delivery route that
is the security boundary the driver cannot be — and RFC 0013 deferred
it as the security-review-heavy surface. This RFC revives that layer as
its own proposal, revalidated against the shipped v1 schema and the
code as of 2026-08-26.

The v1 schema needs **no migration**: the `attachments` row already
carries `id` (ULID), `disk`, and `path`, so the route is "verify
signature → load row → stream from disk", and `urlFor` above is the
seam where the URL policy lives. (Its call sites — `attachmentUrl()`,
`toData()` — gain row context, since a route URL needs the id,
filename, and requested variant that `urlFor(disk, path)` never sees;
the schema and the model API stay untouched.)

### Relationship to RFC 0010 and RFC 0013

- RFC 0010 (Superseded) §3 is the design research this RFC revives; §0
  is the capability matrix whose open probe question (Open Question 6)
  this RFC settles.
- RFC 0013 (Accepted, shipped) defines the schema, the per-disk
  visibility model, and the `attachmentUrl()` contract this RFC plugs
  into. Nothing in RFC 0013's model API changes.
- Where this RFC deviates from RFC 0010 §3 (URL-shaped signatures
  instead of a claims token in the path; an explicit driver capability
  flag instead of a probe), the deviation is stated inline with its
  reason.

### Verified constraints (2026-08-26, against the code)

These shape the design more than any preference does:

- **`signUrl`/`verifySignedUrl` still have zero production callers.**
  `packages/server/src/encryption/signed-url.ts` is exported from the
  package root and exercised only by
  `packages/server/tests/encryption/encryption.test.ts`. It signs via
  `MessageSigner` (HMAC-SHA256, `node:crypto`, timing-safe verify,
  verify walks `[current, ...previous]` for key rotation).
- **`signUrl` cannot sign a path today.** Both functions do
  `new URL(value)` with no base (`signed-url.ts:29`, `:42`), so the
  exact call RFC 0010 §3 wrote — `signUrl('/storage/blobs/…')` —
  throws `TypeError` (verified empirically). This RFC owns the fix.
- **Signatures are host-portable by construction.** `canonicalizeUrl`
  returns `${pathname}${search}` (`signed-url.ts:25`) — no scheme, no
  host, no port. This RFC adopts that property deliberately (§2,
  threat model T6) rather than inheriting it silently.
- **"Purpose-scoped keyring" is two mechanisms, not one.**
  `signUrl` hardcodes a `purpose: 'signed-url'` *claim* inside the
  token (`signed-url.ts:12`) — domain separation among token types.
  *Key* separation is `deriveAppKeyring(root, purpose)` (HKDF-SHA256,
  `packages/server/src/encryption/app-key.ts:56-67`), which the caller
  must apply; `signUrl` never derives. Five production purposes exist
  today (`'csrf-token'`, `'cookie-signing'`,
  `'password-reset-signing'`, `'email-verification-signing'`,
  `'data-encryption'`), each derived at its call site. RFC 0010 §3
  conflated the two; this RFC specifies both explicitly.
- **Signing runs on Workers.** `MessageSigner` is `node:crypto` and the
  Cloudflare plugin's generated `wrangler.jsonc` sets `nodejs_compat`
  unconditionally (`packages/plugin-cloudflare/src/build.ts:378`,
  asserted in its build tests); session-cookie signing already runs on
  guren.dev in production this way (RFC 0003 §6). No WebCrypto port is
  required — and none is attempted here, because `crypto.subtle` is
  async and could not preserve the synchronous `signUrl` signature.
- **`StorageDriver` has no streaming read and no capability
  signalling.** The interface (`packages/server/src/storage/types.ts:59`)
  buffers everything through `get(path): Promise<Buffer | null>`;
  `getStream` appears nowhere in the monorepo, and no capability
  probe of any kind exists. `LocalDriver.get()` is a buffered
  `readFile` (`LocalDriver.ts:83-87`). The only Range/streaming story
  in the repo is `Bun.file` in static asset serving
  (`packages/server/src/http/public-assets.ts:89-105`), which does not
  go through `StorageDriver`.
- **"Can `temporaryUrl()` presign" is observable neither from types
  nor from throws.** `R2Driver` without `presign` throws — but
  `LocalDriver` *succeeds* and returns a plain public URL. A try/catch
  probe therefore misclassifies exactly the disk this RFC most needs
  to get right. This kills option (c) of RFC 0010 Open Question 6.
- **There is no production-active framework-mounted route.**
  `mountDevEndpoint` (`packages/server/src/http/Application.ts:870-888`)
  is precedent for gated mounting, but both users (MCP, docs viewer)
  hard-return `false` in production. Production routes are registered
  by the app (route registrar) or by app-invoked configuration
  (`configureInertiaAssets`). The delivery route follows the
  app-registered shape.
- **Route tooling invokes registrars bootless.** `routes:types`,
  `guren check`, audit, and OpenAPI import the routes file and call
  the registrar against a bare `Router` with **no providers booted**
  (`packages/cli/src/load-routes.ts`, `loadRouteDefinitions`). A
  registrar that throws when configuration is absent breaks every
  inspection tool before it can see the route. Registration must be
  configuration-independent; configuration errors belong to boot.
- **The route addresses variants as `(attachmentId, variantName)`.**
  Variants have object keys (`attachments/{id}/variants/{name}.{ext}`)
  but no rows; every *declared* variant has a status entry in the
  row's `variants` JSON from attach time, which is what lets the route
  distinguish "not generated yet" from "never declared" after a
  reload.
- **`disks` visibility is per disk, defaulting to `'public'`**
  (`engine.ts:1074-1076`), because R2 has no per-object visibility.
  One attachment = one disk = one visibility. This RFC keeps that
  model unchanged.

## Proposed Solution

One GET route, registered by the app, that turns a signed URL into
bytes — by proxying through the app where the disk cannot presign, and
by redirecting to a presigned URL where it can. `attachmentUrl()` on a
private disk returns a signed route URL instead of
`disk.temporaryUrl()`. Everything else in RFC 0013 stays as shipped.

### 1. The route and its URL shape

`registerAttachmentRoutes(router)` (exported from `@guren/core`)
registers, through the public `Router` API so `guren check`,
`routes:types`, and middleware treat it like any app route:

```
GET {prefix}/:id/:filename        name: 'attachments.show'
```

with `prefix` defaulting to `/attachments`. A generated URL looks
like:

```
/attachments/01J8ZK…/report.pdf?disposition=attachment&expires=1756202400&signature=eyJ…
/attachments/01J8ZK…/cover.jpg?variant=thumb&expires=1756202400&signature=eyJ…
```

- `:id` is the attachment ULID (the row key). `:filename` is the
  sanitized stored filename — **it is part of the signed path**, so
  unlike RFC 0010 §3's design there is no unsigned-filename caveat;
  tampering with the filename invalidates the signature. It is still
  used only for `Content-Disposition` (the object key comes from the
  row), and it is a single path segment (no `:name*` — see the route
  path pitfall `guren check` guards).
- Query parameters, all covered by the signature: `variant` (a
  declared variant name), `disposition` (`inline` | `attachment`),
  `expires` (unix seconds, written by the signer), `signature`.

Request handling, in order (cheapest first):

1. `verifySignedUrl(pathAndQuery, keyring, { requireExpiration: true })`
   — at most one HMAC per keyring key, no I/O. Fail → **404** (not
   403: don't confirm the id exists).
2. Load the row by `:id`. Missing → 404.
3. Resolve the object key: no `variant` → `row.path`; `variant` set →
   the row's `variants[name]` when that entry is `ready`, else the
   **original**. The valid signature is itself the proof that the
   variant was declared when the URL was minted — `attachmentUrl()`
   throws on undeclared names *before* signing — so the route never
   404s on variant state. An entry that is missing entirely (a
   variant declared on the model after this row was attached: RFC 0013
   seeds entries at attach time, so pre-existing rows have none),
   `pending`, `failed`, or `unavailable` all get the same
   fall-back-to-original semantics RFC 0013 §7 shipped. Anything else
   would break the no-migration promise for exactly the rows it was
   made about.
4. Serve per the disk's delivery mode (§3): redirect or proxy.

The route is a plain GET: no CSRF interaction, no session requirement
— the signature is the authorization (§8, T9 for what that does and
does not mean). `HEAD` comes with it whether we like it or not: Hono
dispatches every HEAD through the GET handler and discards the body
(`hono-base` `#dispatch`), so the handler checks the method and skips
body acquisition (no storage read, headers only) on HEAD. That check
is mandatory, not an enhancement — without it every HEAD performs the
full DB-and-storage work for a body Hono throws away.

### 2. Signing: `signUrl` fixes, keyring, expiry

**The signer is `signUrl`/`verifySignedUrl`, as RFC 0013 named — with
three additive fixes to `@guren/server` that this RFC owns:**

1. **Relative input — and relative output.** `signUrl`/
   `verifySignedUrl` accept app-relative input (`/attachments/…`) by
   parsing against a fixed placeholder base when `value` starts with
   `/`. The canonical form is already `${pathname}${search}`, so the
   placeholder never leaks into the *signature* — but it must not
   leak into the *return value* either: for relative input, `signUrl`
   serializes `${pathname}${search}` instead of `url.toString()`
   (which would return `https://placeholder.invalid/attachments/…`).
   Tests assert the output shape, not just a sign/verify round-trip —
   a leaked placeholder URL still round-trips. Absolute URLs keep
   working unchanged. Without this fix the call RFC 0010 §3 specified
   throws.
2. **Deterministic canonicalization.** The query-parameter sort uses
   `localeCompare` (`signed-url.ts:19`), which is locale/ICU-dependent
   — sign and verify on different runtimes could disagree for
   multi-parameter URLs. It becomes a plain code-unit comparison.
   Zero production callers means zero compatibility impact; this is
   the last moment the fix is free.
3. **Strict `expires` validation.** Verification today checks only
   `Number(expires) < now` (`signed-url.ts:53`), so `expires=NaN` and
   `expires=Infinity` both pass forever — and `signUrl(..., {
   expiresIn: NaN })` happily produces the former. The verifier
   accepts only a finite positive safe-integer timestamp (anything
   else fails closed), and `signUrl` rejects a non-finite
   `expiresIn`.

**Keyring.** The delivery routes and `attachmentUrl()` sign and verify
with `deriveAppKeyring(getAppKeyringFromEnv(), 'attachment-delivery')`,
derived lazily once per engine — the same idiom as the five existing
purposes. The token additionally carries `signUrl`'s fixed
`purpose: 'signed-url'` claim; the two layers separate keys and token
domains respectively. (RFC 0010 wrote `'attachments'`; the narrower
name is deliberate — the direct-upload follow-up gets its own derived
purpose, so a leaked delivery key cannot mint upload tokens.)

**Expiry.** `expires` is written by `signUrl` in unix seconds, sits
inside the signed canonical form (tamper-proof), and is required at
verification (`requireExpiration: true`). The default lifetime is the
existing `urlExpiresIn` (300 000 ms = 5 minutes) — one knob for both
presigned and route URLs, and the same default Rails uses for its
service URLs. Per-call override:
`Post.attachmentUrl(record, 'cover', { expiresIn })` (additive
option). URLs embedded in emails need deliberately long expiries or an
app-controller wrapper; the docs say so.

**URLs are path-relative.** `attachmentUrl()` returns
`/attachments/…?…` — no host, ever. Inertia pages resolve it against
the current origin; emails and webhooks prefix the app's canonical URL
themselves. This keeps the `Host` header out of URL construction
entirely (threat model T6) and matches the signature's host-portable
canonical form.

### 3. Redirect vs. proxy — settling RFC 0010 Open Question 6

Behind the verified signature, the route picks one of two behaviours
per disk:

- **Redirect** — 302 to a presigned URL **minted per request**:
  `disk.temporaryUrl(key, expiresAt, { responseContentDisposition,
  responseContentType })`, where `expiresAt` is an absolute `Date` at
  `min(remaining signed lifetime, driver cap)`. Minting per request
  is what lets a long-lived route URL (an emailed link) coexist with
  R2's 7-day presign ceiling — the inner presign is always fresh and
  short. `Cache-Control: no-store` on the redirect itself (the
  `Location` carries credentials). The bucket serves the bytes: zero
  app bandwidth, and Range and conditional requests work at the
  bucket. For S3 and R2-with-`presign`.

  The third argument is a new **additive optional options bag on
  `temporaryUrl`** — S3 maps it to `ResponseContentDisposition` /
  `ResponseContentType` on the presigned `GetObjectCommand`, R2 to
  the standard `response-content-disposition` /
  `response-content-type` signed query parameters in `sigv4.ts`. It
  is how the §4 disposition policy survives the redirect instead of
  being silently dropped at the bucket. A third-party driver that
  ignores the bag serves its own object metadata; apps that need the
  disposition guarantee on such a disk force `serve: 'proxy'`.
- **Proxy** — the app streams the object body itself with the
  hardened headers of §4. For `local`, `memory`, R2 on the binding
  alone, and any driver that cannot presign.

**How the route knows which — a declaration, not a probe.** RFC 0010
Open Question 6 listed three options; the code answers it now:

- (c) *probe `temporaryUrl()` in try/catch* is *wrong*, not merely
  costly: `LocalDriver.temporaryUrl()` succeeds and returns a plain
  public URL, so the probe would classify the one disk this RFC exists
  for as presign-capable and 302 private files to public URLs. A probe
  can detect a throw; it cannot detect a lie.
- Driver-name switching penalizes third-party drivers (RFC 0010 §0's
  own rule).

So: **(a) an additive, optional self-declaration on the driver**,

```ts
// packages/server/src/storage/types.ts (additive)
interface StorageDriver {
  // …existing methods…
  /** Capabilities the delivery layer may rely on. Absent ⇒ all false. */
  capabilities?: { presignedGet?: boolean }
}
```

- `S3Driver`: `{ presignedGet: true }`.
- `R2Driver`: computed at construction — `true` iff `presign`
  credentials were configured (the driver already knows; its
  `temporaryUrl` throw message is built from the same fact).
- `LocalDriver`, `MemoryDriver`: not declared. **Absent means false
  means proxy** — the fail-closed direction, because proxy always
  works and never hands out a URL the disk cannot honour.

**(b) as a per-disk override.** The `disks` map in
`configureAttachments()` widens (additive union):

```ts
disks: {
  media: 'public',
  docs: 'private',                                    // string form unchanged
  exports: { visibility: 'private', serve: 'proxy' }, // force proxy on a presign-capable disk
  legacy:  { visibility: 'private', serve: 'direct' }, // keep v1 behaviour: raw temporaryUrl()
}
```

`serve`: `'auto'` (default: redirect iff `capabilities.presignedGet`,
else proxy) | `'redirect'` (boot-time error if the disk does not
declare `presignedGet` — misconfiguration must not fail open into
serving) | `'proxy'` (e.g. keep bucket egress behind the app for IP
allowlisting) | `'direct'` (bypass the route entirely; the v1
`temporaryUrl()` behaviour, for S3 apps that measured the extra hop
and want it gone — with the v1 caveats back).

### 4. Response hardening (proxy mode)

Every rule here closes a concrete hole in serving user-supplied bytes
from the app's own origin:

- **Inline allowlist.** `Content-Disposition: inline` only for:
  `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`,
  `application/pdf`, `video/mp4`, `audio/mpeg`, `text/plain`.
  Everything else — notably `image/svg+xml` and `text/html` — is
  forced to `attachment` regardless of the signed `disposition`
  parameter. The parameter can force `attachment` for an allowlisted
  type; nothing can force `inline` for a non-allowlisted one. The
  served content type is the row's recorded one for the original, and
  **the MIME type derived from `AttachmentVariantRecord.format` for a
  `ready` variant** — variants are transcoded (a PNG original can
  have JPEG/WebP/AVIF variants; generation records `format`, not a
  content type), so serving variant bytes under the original's type
  with `nosniff` would be self-sabotage. Neither is trusted beyond
  the allowlist decision.
- **`X-Content-Type-Options: nosniff`** on every proxied response —
  the recorded type is the served type, and the browser must not
  second-guess it.
- **`Content-Security-Policy: sandbox`** on every proxied response,
  belt over the allowlist's braces: even if a listed type turns out to
  carry active content in some engine, it executes with no origin.
  (PDF viewers and media playback are unaffected.)
- **`Content-Disposition` filename** is the sanitized row filename,
  RFC 5987-encoded (`filename*`), no path separators — same rules the
  attach pipeline already applies before the name becomes a key.
- **Caching.** `Cache-Control: private, max-age=<remaining signed
  lifetime>` — cacheable in the browser, never in shared caches, and
  never beyond the signature's own validity. `ETag` is derived from
  the **resolved object**, not the request: hash of
  `{resolved path}:{size}`, with `If-None-Match` → 304. An
  `id + variant` validator would *not* be a byte identity — a
  `pending` variant resolves to original bytes today and variant
  bytes tomorrow, and queued HEIC conversion rewrites `path` and the
  bytes under the same row id — but the resolved key + size moves in
  both cases, so the validator moves with the bytes.
- **No `Accept-Ranges` in v1** (see §5).

Redirect mode needs none of this (the bucket's presigned response is
out of the app's hands, as it is today), which is one reason `'auto'`
prefers it.

### 5. Streaming — `getStream` ships, Range does not

Today a proxy response would be `disk.get()` → `Buffer` →
`new Response(buffer)`: a 200 MB video buffers 200 MB per request in
the app (or the Worker, where it will not fit). This RFC ships
RFC 0010 §8's additive driver method:

```ts
// packages/server/src/storage/types.ts (additive, optional)
getStream?(path: string, options?: { range?: { start: number; end?: number } }):
  Promise<ReadableStream<Uint8Array> | null>
```

- `LocalDriver`: `node:fs` open/stat **first**, then stream →
  `Readable.toWeb` — works on Bun and Node, no Bun-only API in
  `@guren/server` (per the package's Bun-isolation rule). The
  explicit open is what makes the promised `null` for a missing file
  honest: a naïve `createReadStream()` returns before its async open
  fails.
- `R2Driver`: `obj.body`, cast at the same boundary where the driver
  already absorbs the workerd-vs-global stream type mismatch (it
  deliberately types `body` loosely because Cloudflare's
  `ReadableStream` is not assignable to the global one); the
  binding's `get(key, { range })` maps directly onto the options bag.
- `S3Driver`: `Body.transformToWebStream()` — the SDK body is not
  itself a web stream on Node; the `Range` header maps onto the
  options bag. The interface contract is explicit: every implementer
  **normalizes to the global web `ReadableStream`** at its own
  boundary.
- `MemoryDriver`: not implemented; the route falls back to buffered
  `get()` wherever `getStream` is absent — the same graceful-degrade
  contract as every optional capability here.

**Range requests are explicitly out of scope for v1**, with the
extension point reserved (the `range` options bag above), so adding
them later changes no interface. Rationale: single- and multi-range
parsing, 206/416 semantics, and range×ETag interaction roughly double
the surface of exactly the code a security review must read, and the
main consumer (video seeking) has a shipping answer — redirect mode,
where the bucket serves Ranges natively. The docs state the v1
consequence plainly: seekable video on a *proxy-only* private disk
(local dev, R2 binding) downloads linearly until the fast-follow
lands. Whether Range must ride v1 after all is Open Question 1.

### 6. Configuration and wiring

Two touchpoints, both app-owned, both opt-in:

```ts
// config/attachments.ts
export const { Attachment } = configureAttachments({
  table: attachments,
  storage: () => container.make('storage'),
  disk: 'media',
  disks: { media: 'public', docs: 'private' },
  delivery: {                    // NEW — presence turns the feature on
    prefix: '/attachments',      // default
    // expiry rides the existing urlExpiresIn
  },
})
```

```ts
// routes/web.ts
import { registerAttachmentRoutes } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  registerAttachmentRoutes(router)   // mounts GET {prefix}/:id/:filename
  // …app routes…
}
```

- **Why app-registered, not boot-mounted:** there is no
  production-active framework-mounted route to set precedent (the
  MCP/docs-viewer machinery is dev-only by design), and registering
  through the app's registrar keeps the route visible to `guren
  check`'s registrar-wiring and route-contract rules, orderable
  against app middleware, and prefix-controllable — the same reasons
  `configureInertiaAssets` is app-invoked. The route handler ships as
  a framework controller, so the route↔controller integrity checks
  see a real target.
- `registerAttachmentRoutes` **never throws at registration time**:
  the route-inspection tools (`routes:types`, `guren check`, audit,
  OpenAPI) invoke registrars against a bare `Router` with no
  providers booted (`load-routes.ts`), so a config-dependent throw
  would break every one of them before the route was visible.
  Registration is pure; the controller resolves the engine lazily at
  request time (a clear 500 with a config-pointing message if it is
  missing), and "delivery not configured" is a boot-time error in the
  engine wiring plus the `guren check` rule below.
- The route name defaults to `attachments.show` and is configurable
  (`delivery.routeName`). `Router.name()` silently overwrites a
  duplicate named route, so the docs reserve the default name and the
  check rule warns on a collision.
- The inverse hole is a `guren check` rule: `delivery` configured (or
  any disk `'private'` while `delivery` is set) but no reachable
  `registerAttachmentRoutes(...)` call in the mounted registrar —
  private URLs would be minted that 404.
- Without `delivery`, nothing changes: `urlFor` keeps the v1
  behaviour, and the v1 documented limitations stand.

### 7. What `attachmentUrl()` now returns

With `delivery` configured, the §1 `urlFor` seam becomes:

| Disk visibility | serve | URL |
|---|---|---|
| `public` | — | `disk.url(path)` — unchanged, CDN-cacheable, the route is never involved |
| `private` | `auto`/`redirect`/`proxy` | signed route URL (path-relative) |
| `private` | `direct` | `disk.temporaryUrl(path, expiry)` — v1 behaviour |

This applies identically to `AttachmentData.url` and every
`variants[name].url` in resource payloads — the not-`ready` variant
fallback keeps pointing at the original, now through the route. Public
attachments never touch the route in generated URLs, and v1 ships no
API that mints a signed URL for a public-disk attachment — a
forced-download helper for public files is possible on this
foundation, but it is a follow-up, not a side effect.

**Uniform-route rule, adopted from RFC 0010 §3:** the signed route URL
is *the* private URL on every driver. S3-private apps switch from
direct presigned URLs to route-then-302 — one extra request, in
exchange for `Content-Disposition` control (carried into the presign
via the `temporaryUrl` response-override bag, §3), one place to
reason about keys and expiry, and one URL shape. The §4 inline
allowlist is a *same-origin* defense and applies where same-origin is
at stake — proxy responses; a redirect hands the browser to the
bucket's origin, where an inline SVG is not the app's XSS problem.
Apps that measured the hop and want the old behaviour say
`serve: 'direct'` per disk.

### 8. Threat model

The concrete threats this surface must answer, and where each is
closed:

| # | Threat | Answer |
|---|---|---|
| T1 | **Forged or tampered URL** (path, id, variant, disposition, expiry) | Everything is inside the signed canonical form (`pathname + sorted query`, only `signature` stripped). HMAC-SHA256 via `MessageSigner`, constant-time compare. Any mutation → 404. |
| T2 | **Replay after expiry** | `expires` is signed and mandatory (`requireExpiration: true`); verification rejects past timestamps before any I/O. |
| T3 | **Enumeration / IDOR** | The id is a ULID (unguessable before insert) *and* no response differs before signature verification — invalid signature, unknown id, and undeclared variant are all 404. The signature, not the id's secrecy, is the boundary. |
| T4 | **Key compromise blast radius** | HKDF purpose `'attachment-delivery'`: a leaked delivery key forges delivery URLs and nothing else — not sessions, not CSRF, not password-reset links, and not the future direct-upload tokens (separate purpose). Rotation rides `APP_KEY`/`APP_PREVIOUS_KEYS` (verify walks previous keys). |
| T5 | **Stored XSS via uploads served same-origin** (SVG/HTML with scripts) | Inline allowlist forces non-listed types to `attachment`; `nosniff` pins the recorded type; `CSP: sandbox` de-origins whatever renders inline anyway. Scope: this is the *proxy* path's defense — a redirect lands on the bucket's origin, where same-origin is not at stake and the disposition still travels via the presign response-override (§3). |
| T6 | **Host-header poisoning of generated or verified URLs** | URLs are generated path-relative and signatures canonicalize to path+query — the `Host` header is never read on either side. The deliberate flip side: a signed URL verifies on any hostname the app answers on (multi-domain and proxied deployments keep working; the signature never gates *which* origin, only *what*). The assumption this rests on, stated explicitly: **one `APP_KEY` = one authorization domain** — the same assumption sessions and CSRF already ride, so a deployment sharing keys across tenants or environments is already broken in worse ways than attachment URLs. An app genuinely serving multiple security domains from one keyring can be given a signed, *configured* audience claim later (still no request-header trust); not in v1. |
| T7 | **Path traversal / key injection** | The object key comes from the row (written by the attach pipeline's sanitizer), never from the request. The `:filename` segment is decorative for `Content-Disposition` only, single-segment by route shape, and signed. |
| T8 | **Cache poisoning / leak via shared caches** | Proxy: `Cache-Control: private`, max-age capped at remaining signature lifetime. Redirect: `no-store` (the `Location` is a credential). Signed query params make cache keys unique per grant anyway. |
| T9 | **"Signed URL" misread as revocable authorization** | Stated contract: this is a capability URL — anyone holding it reads the bytes until expiry. Revocation means **removing** the compromised key: rotation alone revokes nothing while the old key sits in `APP_PREVIOUS_KEYS`, because verification deliberately walks previous keys — and a browser-cached response stays usable until its `max-age` ends regardless. Per-request authorization (`authorize(row, ctx)` callback) is deliberately **not** in v1, unchanged from RFC 0010 §3: apps needing it wrap `attachmentUrl()` in their own controller behind their own middleware and hand out short-lived URLs. Revisit if the wrapper turns out to be the common case. |
| T10 | **Resource exhaustion through the proxy** | Verification costs at most one HMAC per keyring key before any DB or storage I/O, so garbage URLs are cheap to reject, and streaming (`getStream`) keeps large bodies out of app memory where drivers implement it. **Partially open, stated honestly:** the buffered fallback has no framework-level size bound for opaque (non-image) collections — `maxImageBytes` gates only the image-policied attach path — and streaming caps memory, not bandwidth, open-stream concurrency, or storage read cost for a repeatedly fetched valid link. The route ships no rate limiter of its own; it composes with app middleware (`.middleware(...)`), and the docs tell bandwidth-sensitive apps to rate-limit the prefix and prefer redirect-capable disks. |
| T11 | **Open redirect** | The 302 `Location` is exclusively `disk.temporaryUrl()` output — driver-built from row data, no request input. |
| T12 | **Signature-verification bypass via canonicalization disagreement** | The `localeCompare` sort is replaced by code-unit comparison (§2) so signer and verifier can never canonicalize differently across runtimes/locales. |
| T13 | **Signed-URL leakage via logs, referrers, history** | The signature is a bearer credential in a query string. Route responses set `Referrer-Policy: no-referrer` (the app-wide default `strict-origin-when-cross-origin` still sends the full URL on same-origin navigation, and apps can weaken it); expiry bounds the damage window — one reason the default lifetime is minutes, not days; the docs require query redaction in access logs for the route prefix and note browser-history exposure. |
| T14 | **"Private" disk whose backing store is itself public** | The route is a lock on the app path only — it cannot un-publish an S3/R2 bucket configured public or a local directory the app still serves statically. `disks` visibility is policy metadata, not proof: nothing at attach time verifies the bucket's actual ACL or the static mounts. Adoption therefore includes closing the direct path (Migration Path spells out the local two-step), and a `guren check` candidate rule flags a `'private'` disk whose storage config carries a public `url`/`publicUrl` or whose local root sits under the app's public directory. |

Non-goals restated as such: the route does not authenticate users
(T9), does not make `disks` visibility per-object (RFC 0013's
per-disk decision stands), and does not attempt DRM — a private
attachment shown to a user is a private attachment that user can save.

### 9. Package placement, exports, release order

| Package | Adds |
|---|---|
| `@guren/server` | the three §2 signer fixes (relative input/output, code-unit canonicalization, strict `expires`); `StorageDriver.getStream?` + `capabilities?` + the §3 `temporaryUrl` response-override options; `LocalDriver.getStream`, `S3Driver.getStream`, `S3Driver.capabilities`, S3 response overrides *(row amended in Part 1: the original omitted the strict-`expires` fix and the `temporaryUrl` bag that §2/§3 already specified)* |
| `@guren/core` | `delivery` option on `configureAttachments`; `registerAttachmentRoutes` + the delivery controller; `urlFor` switch; **core-native export** → explicit `packages/core/src/index.ts` wiring + a core changeset (allowlist rule) |
| `@guren/plugin-cloudflare` | `R2Driver.getStream`, `R2Driver.capabilities` (from `presign` presence); Cloudflare guide: "private attachments on the binding, no `presign` needed" |
| `@guren/cli` | `guren check` rule (§6); scaffold template comment update (`packages/cli/templates/scaffold/attachments/config/attachments.ts`) |
| docs | `docs/{en,ja}/guides/attachments.md` "URLs and visibility" — the two documented limitations are deleted, the route documented; storage guide cross-links; the ja guide's "アタッチメントは配信ルートを追加しません" line is superseded |

Release order per the templates-resolve-from-npm rule: server first
(the additive driver/signer surface), then core + plugin (both consume
it; the plugin's current `compatibility` range already admits a minor
core line — `audit:plugin-compat` re-verifies at release rather than
this RFC assuming), then cli/templates/docs adoption. No template may
reference `registerAttachmentRoutes` before the core release ships
it.

Semver: everything is additive — server minor, core minor, plugin
minor. No breaking change; `serve: 'direct'` preserves any behaviour
an app wants to keep.

### Implementation plan

1. **Part 1 — server:** the §2 signer fixes (relative input/output,
   code-unit sort, strict `expires`) + `getStream?`/`capabilities?`
   and the §3 `temporaryUrl` response-override options on the
   interface + Local/S3 implementations. Tests: sign/verify
   round-trips relative and absolute, output shape (no placeholder
   origin), canonicalization order pins, malformed-`expires`
   rejection, stream vs. buffered parity per driver, response
   overrides reaching the presigned command.
2. **Part 2 — core:** `delivery` config + `registerAttachmentRoutes`
   + the controller (verify → load → resolve variant → redirect/proxy
   with §4 headers) + `urlFor` switch + `AttachmentData` passthrough.
   Tests drive the route in-process over `local` and `memory`
   (buffered fallback), assert every §4 header, the allowlist
   force-to-attachment, 404 uniformity (T3), and expiry.
3. **Part 3 — plugin-cloudflare:** `R2Driver.getStream` +
   `capabilities`; Miniflare-harness test that a private binding-only
   disk round-trips through proxy mode; Cloudflare guide section.
4. **Part 4 — cli + docs:** `guren check` rule, scaffold comment,
   guide rewrites (en/ja), storage-guide best-practice update.

Each part is one PR (`Refs: RFC 0015`); Parts 3–4 are independent once
Parts 1–2 land.

## Alternatives Considered

- **RFC 0010 §3 verbatim: a claims token in the path**
  (`/storage/blobs/:signedId/:filename`, payload
  `{ blobId, disposition, variant? }`). Works, but the filename stays
  unsigned (RFC 0010 carried that as an accepted caveat), the URL is
  opaque to humans and logs, and it leaves `signUrl` — the machinery
  RFC 0013 explicitly names as the intended signer — unused forever.
  URL-shaped signing makes the entire URL tamper-proof, keeps ids
  visible for debugging (they are ULIDs, not secrets — T3), and gives
  the framework its first production `signUrl` caller.
- **Boot-time capability probe** (`temporaryUrl()` in try/catch —
  RFC 0010 OQ6 option (c)). Misclassifies `LocalDriver`, which
  returns a plain URL instead of throwing: the probe would 302
  private local files to public URLs. Also does network I/O at boot
  on S3. A probe can detect a throw; it cannot detect a lie.
- **Per-request probe / error-code convention** (the
  `ERR_IMAGE_FORMAT_UNSUPPORTED` idiom from RFC 0013 §5). Same lie
  problem, per request instead of per boot.
- **Keep direct presigning for capable disks; route only for
  local/R2-binding.** Fewer hops for S3, but two URL behaviours to
  document, no `Content-Disposition`/allowlist control on the
  presigned path, and the migration story splits per driver. Offered
  per disk as `serve: 'direct'` instead of being the default.
- **Framework-mounted route at boot** (extend `mountRoutes()` /
  always-on provider). No production precedent, invisible to the
  registrar-wiring checks, and takes prefix/middleware control away
  from the app. App registration costs one line.
- **A per-object `visibility` column.** Re-litigates RFC 0013's
  per-disk decision and breaks its no-migration promise; R2 still
  cannot enforce it at the bucket. Per-disk visibility + this route
  covers the cases a column would.
- **WebCrypto reimplementation of the signer** (fully
  Workers-native, no `nodejs_compat`). `crypto.subtle` is async, so
  it cannot preserve the synchronous `signUrl` API — a breaking
  change to solve a problem no deployment has: `nodejs_compat` is set
  unconditionally by the plugin and HMAC signing already runs on
  guren.dev in production. `sigv4.ts` proves a WebCrypto signer is
  writable here if that ever changes.
- **Range support in v1.** Doubles the reviewable surface of the
  security-critical handler for a need redirect mode already serves;
  deferred with the driver-level extension point reserved (§5,
  OQ1).
- **Serving variants from a separate route** (RFC 0010's
  `/storage/variants/…`). One route with a signed `variant` parameter
  reaches the same bytes with half the surface; variants have no
  independent identity in the v1 schema anyway.

## Migration Path

Additive and opt-in; nothing changes until an app both configures
`delivery` and registers the route.

- **Public disks:** no change, before or after adoption.
- **Private S3 / R2-with-`presign` disks:** on adoption, freshly
  generated URLs become route URLs (302 to a presigned URL).
  Previously issued presigned URLs expire on their own schedule;
  nothing breaks mid-flight. `serve: 'direct'` opts a disk back out.
- **Private `local` disks:** adoption makes the route the *intended*
  path, but the files stay reachable at their plain URLs until the
  app stops serving that directory publicly (the disk's `baseUrl`
  static mount / `storage:link`). The docs make this two-step
  explicit — registering the route without closing the public mount
  is a lock on an open door.
- **Private R2-binding disks:** these could not produce URLs at all
  (`temporaryUrl` throws); adoption takes them from broken to
  working. No presign credentials required anymore — RFC 0013 §7's
  documented requirement is deleted.
- **Existing rows:** fully covered with no migration — the route
  reads `id`/`disk`/`path`/`variants` that every v1 row already has.

## Open Questions

1. **Range in v1 after all?** Local-dev video on a private disk
   downloads linearly until the fast-follow. If dogfooding (the
   blog example's uploads, or guren.dev) hits this immediately, the
   reserved `getStream` range bag makes pulling it forward cheap —
   but it re-opens the 206/416/`If-Range` surface for review.
2. **Default expiry for share-able links.** 5 minutes is right for
   page renders; URLs pasted into chat or email die confusingly
   fast. Is a documented `{ expiresIn }` override enough, or should
   `delivery` grow a named preset (e.g. `linkExpiresIn`) so apps
   stop inventing magic numbers?
3. **Route naming.** `attachments.show` under `/attachments` is
   proposed; RFC 0010 used `/storage`. `/attachments` avoids
   colliding with `LocalDriver`'s conventional `/storage` public
   base URL — is there a reason to prefer matching Rails'
   `/rails/active_storage`-style dedicated prefix instead?
