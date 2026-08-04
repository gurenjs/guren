---
"@guren/cli": patch
"@guren/server": patch
"create-guren-app": minor
---

Build emailed auth links from `APP_URL` instead of the request host

The password reset flow scaffolded by `guren add auth` (and by
`create-guren-app --auth`) built its link from the request:

```js
buildPasswordResetUrl(`${new URL(this.request.url).origin}/reset-password`, token, email)
```

A server request's URL is reconstructed from the `Host` header, which any
client can forge — the framework's own host-authorization middleware says so,
reading `ctx.req.header('host') ?? new URL(ctx.req.url).host` as one value. So
an unauthenticated attacker could `POST /forgot-password` with someone else's
address in the body and `Host: attacker.tld`, and the app would mail *that
person* a genuine, single-use reset link pointing at the attacker's server. The
victim sees a legitimate mail from the real service; one click — or one
link-prefetching mail scanner — hands over the token, and `ResetPasswordController`
accepts it with no session binding or second factor.

Scaffolds now route every emailed link through a generated `app/Auth/AppUrl.ts`,
which reads `APP_URL` and **fails closed in production** rather than falling back
to the request. Development keeps working with no configuration. The three email
verification sites got the same treatment: they mail the requester's own address,
so they were not exploitable, but they were the same pattern.

Templates also stop disabling host authorization in production. It was
`process.env.NODE_ENV === 'production' ? false : { ... }`, which removed the
middleware in exactly the environment that needed it; the production branch now
derives its allowlist from `APP_URL`'s hostname, and health-check paths stay
excluded so load balancers reaching the app by IP are unaffected. When `APP_URL`
is not readable at module scope the template warns and leaves the check off
rather than throwing — the Cloudflare worker imports the app before wrangler
`vars` reach `process.env`, and a throw there would stop the app booting at all.
`guren audit` now also flags `hostAuthorization: false`, which it previously
walked past while the templates themselves shipped it.

In `@guren/server`, a `host:*` allowlist entry now means "this host on any
**port**". `compileHostMatcher` accepted anything after the colon, so
`example.com:*` also matched a `Host` of `example.com:attacker.tld`. The same
middleware stops re-parsing the whole request URL to read its path on every
request, which it now does in production rather than only in development.

**Action required for new apps:** `APP_URL` must be set in production. It is
already present in the scaffolded `.env.example`. Existing apps are unchanged —
if yours has a `ForgotPasswordController` generated before this release, apply
the same change by hand, or re-run `guren add auth --force`.
