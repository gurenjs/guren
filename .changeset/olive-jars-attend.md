---
'@guren/server': patch
---

fix(server): force document types served out of `public/` to download

The `public/` tree is not only build output. The attachments scaffold roots
its `public` storage disk inside it (`./public/storage`), so a file there can
be an upload that kept the uploader's own extension and content type. Served
back as `text/html` or `image/svg+xml` from the app's own origin, that is
stored XSS: session-riding requests, CSRF-token reads, account takeover.

Two routes reach that directory and neither stopped it. The extension
allowlist in `registerRootPublicAssets` was declared to be the gate, but
`configureInertiaAssets` also mounts an unfiltered `serveStatic` at
`/public/*` (and `registerDevAssets` mounts the same one, so `bun run dev` was
not exempt); `.svg` is in the allowlist's own default extensions, so it was
reachable through the declared gate too.

Both mounts, and the `/resources/css/*` one beside them, now answer with
`Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` for
the content types a browser renders as a document in the serving origin:
`text/html`, `text/xml`, `application/xml`, `text/xsl`, and any `*+xml`
(`application/xhtml+xml`, `image/svg+xml`, `application/xslt+xml`).

`Content-Disposition` is honoured for navigations and ignored for subresource
loads, so `<img src="/logo.svg">`, `<link rel="icon">` and CSS `url()` are
unaffected. Scripts, stylesheets, fonts, images, media and PDFs are untouched.

What does change, beyond opening such a URL directly:

- an SVG or HTML page embedded through `<iframe>` or `<object>` no longer
  renders, because that is a navigation;
- a directory request resolves to its `index.html` before the guard runs, so
  `public/site/` now downloads rather than renders. A static microsite under
  `public/` is the one legitimate flow this stops.

Opt back in per route family: `rootPublicAssets: { inlineDocuments: true }`
for the root-level allowlist, and `inlineDocuments: true` on
`configureInertiaAssets` / `registerDevAssets` for `/public/*` and
`/resources/css/*`. Turn either on only for a directory holding nothing
user-supplied.

Two scope limits worth stating:

- This covers the app's own static serving, which is what `bun bin/serve.ts`
  and the Docker image use. A deployment fronting `public/` with platform
  static assets, a CDN, or nginx serves those files without reaching this
  middleware and needs the same header policy configured there.
- Root-level assets are served `public, max-age=31536000, immutable`, so a
  browser or shared cache holding a pre-upgrade inline response keeps it. An
  app that has already accepted uploads should rotate those URLs or purge the
  cache rather than rely on the upgrade alone.
