---
"@guren/core": patch
"@guren/plugin-cloudflare": patch
---

Stub the unused database clients in the Cloudflare worker bundle

A scaffolded app switched to D1 could not be deployed. `wrangler deploy`
failed with `Could not resolve "postgres"` — naming a database its author had
deliberately not chosen — and then `mysql2/promise` and
`@aws-sdk/client-rds-data` behind it.

`@guren/orm` names each dialect's client in a *literal* dynamic import, and a
bundler follows those whether or not the branch can be taken. On Workers none
of them can be: D1 is the only database there is. `cloudflare:build` now
writes a stub for each and aliases it, the same way it already handles
`bun:sqlite` and the Vite dev server. Apps that worked around this by
installing `postgres` and `mysql2` they never used can drop them.

The clients live in their own `SQL_CLIENT_MODULES` list rather than the
existing dev-only one, because whether they are dead weight is a property of
the platform: Lambda and Vercel connect to Postgres through them, and
stubbing them there would break a working deploy. Each platform's message
table is now keyed on the modules it actually stubs, so a Workers-only entry
cannot silently demand a message from a plugin that never renders it.

Nothing had caught this: no gate ran wrangler over an app that imports the
ORM, and the one Workers app in this repository carries a leftover `postgres`
dependency from before it moved to D1, which masked the failure. An opt-in
`GUREN_TEST_WRANGLER=1` test now bundles such an app with no client
installed. It installs the ORM from a tarball rather than a local path,
because a linked install resolves out into this repository's own
`node_modules` — which is how the first version of the test passed with no
stubs at all.
