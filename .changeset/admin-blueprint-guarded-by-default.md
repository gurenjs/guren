---
'@guren/cli': patch
---

Guard the `add admin` dashboard by default, like `make:feature`

`guren add admin` emitted `router.get('/admin', [AdminDashboardController, 'index'])`
with no middleware and a controller with no auth call, and wired it into
`routes/web.ts`. Nothing was disclosed — the page renders three hardcoded zeros —
but it diverged from `make:feature`, which guards by default and offers
`--public` to opt out, and the guide did not mention that the route was open. The
first real query added to that dashboard made it an unauthenticated admin page.

The route now carries `requireAuthenticated({ redirectTo: '/login' })` and the
action calls `this.auth.userOrFail()`; `--public` restores the previous output.

The middleware is attached inline rather than through an `'auth'` alias. This
file lands in apps that may never have run `guren add auth`, and
`aliasMiddleware('auth', …)` writes into the router shared with `routes/web.ts`,
so registering it here would silently replace an alias the app configured with
different options. On an app without auth installed the request is redirected to
a `/login` that does not exist yet, rather than failing to boot.
