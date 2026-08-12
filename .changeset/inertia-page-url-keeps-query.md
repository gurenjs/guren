---
'@guren/server': patch
'@guren/testing': patch
'@guren/cli': patch
'create-guren-app': patch
---

Keep the query string in the default Inertia page url

`Controller.inertia()` resolved the page `url` from `ctx.req.path`, which is
the pathname only — so `usePage().url` never saw the current query
parameters. Anything deriving state from the query (pagination, filters,
sort order) silently lost it on every visit, and navigation components that
propagate the active query onto their links emitted bare paths. The Inertia
protocol expects `url` to include the query string (`"/posts?page=1"`).

The default is now the pathname plus the query string, derived from the full
request URL, and stays relative as the protocol expects. An explicit
`options.url` still overrides it. The `@guren/testing` controller mock
mirrors the same default.

The `make:auth` scaffolds and the create-app templates no longer pass
`url: this.request.path` — they rely on the default, so generated apps get
the query-preserving value instead of re-introducing the lossy form.
