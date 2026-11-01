---
'@guren/server': patch
---

`Controller.text()`, `json()`, `created()`, `accepted()`, `redirect()` and `inertia()` (and the standalone `inertia()` helper) merge the caller's headers case-insensitively, so `this.text(feed, { headers: { 'content-type': 'application/rss+xml' } })` serves the caller's type instead of sending it beside the default `text/plain` (Bun joined the two into one `Content-Type` value). Headers passed as a `Headers` instance or a list of pairs are kept as well; they used to be dropped.
