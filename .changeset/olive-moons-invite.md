---
'create-guren-app': patch
---

Cover `tests/` in the api-only template's TypeScript `include`.

The api-only starter ships `tests/app.test.ts`, and it was the one file the
template's own `typecheck` script never read. That was deliberate: the test
passes `providers: [DatabaseProvider]` to `TestApp.create()`, and
`@guren/testing` typed that parameter as `new (...args: unknown[]) => ProviderLike`
— a shape no real `ServiceProvider` subclass satisfies, because constructor
parameters are contravariant and the inherited constructor takes a concrete
`Container`. Widening the include before that was fixed would only have made
the starter smokes red.

`@guren/testing@1.6.1` fixes it, so the include can now cover what it always
should have. The default template already listed `tests/`; the two templates
agree again.
