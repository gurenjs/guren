---
'@guren/server': minor
'@guren/core': minor
---

Close a stored-XSS hole at the static-serving layer: files a browser renders as *documents* are now served with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`.

`.svg` is in the root public mount's default extension list and maps to `image/svg+xml`; the `/public/*` mounts serve whatever is under the directory, `.html` included. Navigated to at its own URL, such a file is a page on the serving origin — its `<script>` runs with that origin's cookies and storage. Any application that lets a user put a file under `public/`, directly or through an upload disk rooted there, therefore had stored XSS whatever its own pages render. `nosniff` does not help: the content type is declared and correct, and the browser is honouring it.

The policy is the one the attachments delivery route already applies (`INLINE_CONTENT_TYPES`), stated as its complement. Delivery serves user uploads and can allowlist what may render inline; a static mount has to keep serving the scripts, stylesheets and fonts a page loads, so what it can enumerate is the document types: `text/html`, `application/xhtml+xml`, `image/svg+xml`, `text/xml`, `application/xml`, `text/xsl`, and the `+xml` structured suffix, which covers feeds. One predicate now decides this for every mount — the root public middleware, the dev `/public/*` and `/resources/css/*` routes, the dev transpile route's static fallback, the production `/public/*` route, and the built Inertia client — so a mount cannot disagree with another about what is a document.

**Assets are unaffected, verified in a browser rather than reasoned about.** `Content-Disposition` decides navigate-versus-download and is ignored for subresource fetches: with the header in place, `<img src="/logo.svg">` still decodes (`naturalWidth` unchanged), a CSS `url()` still resolves and a `<link rel="icon">` is still fetched, while a top-level navigation downloads the file instead of executing it. The one behaviour that changes is the one that was the hole.

**A static `.html` under `public/` is no longer navigable.** The scaffold's `public/index.html` is a Vite entry that production never serves, so scaffolded apps are unaffected — but an application that put a real page there and links to it will now hand visitors a download. Serve such a page from a controller instead.

This is the serving half of the fix; `guren check`'s `attachments-public-disk` rule and the scaffold change that stopped rooting uploads inside `public/` address where files land, not what happens when one is requested.
