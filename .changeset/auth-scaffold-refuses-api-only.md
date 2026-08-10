---
'@guren/cli': patch
---

Refuse the auth scaffold on an API-only app instead of writing pages it cannot render

`guren add auth` and `guren make:auth` scaffold an Inertia sign-in experience, and
on an app created from the `api` blueprint none of it worked. The controllers
return Inertia responses and the pages they name (`resources/js/pages/auth/*.tsx`,
`resources/js/components/Layout.tsx`) are React components, so nothing typechecked
against a `@guren/inertia-client` the API starter never installs. The route wiring
targets `routes/web.ts`, which that starter does not have — it registers
`registerApiRoutes` from `routes/api.ts` — so `routes/auth.ts` was written and
mounted by nothing, and the CLI still printed that you could visit `/login`.

Auth also patches `db/schema.ts` and generates a users migration, so the check runs
before the first write rather than before the first file: a run stopped halfway
through those leaves changes no `--force` rerun undoes. It refuses with a message
naming both signals it read and leaves the app exactly as it was.

The refusal points at the token flow the framework already ships —
`createBearerTokenMiddleware` over a `DatabaseApiTokenStore` or
`RedisApiTokenStore` — rather than scaffolding it. Generating that variant is a
separate piece of work, not a smaller one: it needs a parallel set of controller
and route templates for each of the four sign-in shapes this command supports, an
`api_tokens` table and migration alongside the users one, a routes target other
than the hardcoded `routes/web.ts`, and an answer for the registration, password
reset, and email verification flows, which mail absolute links whose only landing
pages are the ones being refused.
