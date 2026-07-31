---
"create-guren-app": minor
---

Re-add the `blog` blueprint as a template that ships

`--blueprint blog` is back, this time as a curated template under `templates/`
instead of an overlay of the `examples/blog` workspace, which no published
tarball contains. It layers posts CRUD, session authentication, an ownership
policy, and a seeded demo account over the default template, and it applies
`default-ssr` in SSR mode — the blueprint it replaces skipped that layer and
scaffolded an SSR app with no `ssr.tsx` entry.

The schema comes from the template rather than a generator in `blueprints.ts`.
A template can now ship `db/schema.<driver>.ts` per driver; the scaffolder keeps
the one matching the selected database, renames it to `db/schema.ts`, and
deletes the rest. A template that ships some drivers but not the selected one is
reported as an incomplete build instead of silently falling back to the generic
single-table schema, which would scaffold models pointing at tables that do not
exist. This is what the old blueprint's hand-maintained schema copy existed to
work around, and what let it drift from the columns its own controllers read.

`--auth` is ignored for blueprints that already ship authentication, with a note
saying so: it runs `guren add auth --force`, which would overwrite the
template's own controllers, routes, and `User` model with the generic ones. The
"add features" next steps no longer suggest adding auth to an app that has it.

Two things the template does that `guren add auth`'s output does not, both
found by driving the scaffolded app in a browser: it shares the signed-in user
with Inertia from `AuthProvider.boot()`, without which every page renders as a
guest and the authenticated nav never appears, and it logs out through an
Inertia `Link` rather than a native `<form method="post">`, which carries no
CSRF token and is rejected with a 403.

`smoke:starter:blog` scaffolds, typechecks, and builds the blueprint in CI
alongside the existing `api` and `worker` smokes. Like every other starter
smoke it covers SQLite only; the PostgreSQL and MySQL schemas this blueprint
ships were typechecked and run through `drizzle-kit generate` by hand.

The `User` model follows RFC 0006's structural mass-assignment model
(`defineModel(users, { base: AuthenticatableModel, ... })`, no `guarded`) —
`passwordHash` and `rememberToken` are denied by `AuthenticatableModel` itself,
and `Post.fillable` never lists `authorId`, which is set from the session via
`forceCreate()` in `PostController.store()`.
