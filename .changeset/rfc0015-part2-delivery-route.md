---
'@guren/core': minor
---

Signed attachment delivery route (RFC 0015 Part 2).

`configureAttachments()` gains a `delivery` option and a widened `disks`
map (`'public' | 'private' | { visibility, serve }` with
`serve: 'auto' | 'redirect' | 'proxy' | 'direct'`). With `delivery`
configured, `attachmentUrl()` and `AttachmentData` URLs for private disks
become path-relative signed route URLs (HMAC-signed with a keyring derived
for the `'attachment-delivery'` purpose, expiring after `urlExpiresIn`,
with per-call `expiresIn` and `disposition` overrides) instead of
`disk.temporaryUrl()` — closing the v1 gap where "private on the local
disk" was not actually private and private R2 required `presign`.

`registerAttachmentRoutes(router)` mounts the route
(`GET /attachments/:id/:filename`, name `attachments.show`, both
configurable) from the app's route registrar. It serves by verifying the
signature (uniform 404 on any failure), loading the row, resolving the
variant at serve time (not-ready variants fall back to the original), and
then either 302-redirecting to a per-request presigned URL on disks that
declare `capabilities.presignedGet` (with `Content-Disposition` /
`Content-Type` carried via the presign response overrides) or proxying the
bytes with hardened headers: an inline allowlist (SVG/HTML forced to
`attachment`), `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: sandbox`, `Referrer-Policy: no-referrer`,
signed-lifetime-capped `Cache-Control: private`, and an ETag keyed on the
resolved object with `If-None-Match`/`HEAD` support.

Additive and opt-in: without `delivery`, nothing changes.
