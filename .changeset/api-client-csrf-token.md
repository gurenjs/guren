---
"@guren/cli": patch
"create-guren-app": patch
---

Make the generated API client CSRF-safe by default. `createApiClient()` now
copies the `XSRF-TOKEN` cookie into the `X-XSRF-TOKEN` header on
state-changing requests, so `client.request('posts.store', { body })` no
longer gets a 403 from the CSRF middleware that ships enabled by default.

The copy happens only when the request targets the page's own origin — the
cookie belongs to that origin, and sending it to a third-party `baseUrl`
would disclose the page's CSRF token. A cross-origin client, or one talking
to a server configured with `csrf({ cookie: false })`, supplies its own
`X-XSRF-TOKEN` header; caller-supplied `X-XSRF-TOKEN` / `X-CSRF-TOKEN`
headers are left untouched whatever their casing. The cookie is read through
`globalThis`, so the generated module stays import-safe during SSR.

Requests also carry an explicit `credentials: 'same-origin'` — the fetch
default, now overridable through the new `credentials` option.
