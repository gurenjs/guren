---
'@guren/testing': patch
---

Let `TestApp.create({ providers })` accept a real `ServiceProvider` subclass.

The option was typed `new (...args: unknown[]) => ProviderLike`. Constructor
parameters are contravariant and `ServiceProvider`'s constructor takes a
concrete `Container`, so `unknown` was not assignable to it and *no* provider
class satisfied the type — passing one produced `error TS2322: Type 'typeof
DatabaseProvider' is not assignable to type 'ProviderConstructor'`. The
api-only starter template ships a test file that uses the documented API and
did not typecheck because of it.

The parameters are now `any[]`, which is what a constructor-shape type needs
in order to be assignable from a constructor that takes anything at all. It
stays structural rather than reusing `@guren/server`'s
`ServiceProviderConstructor`, so the published `.d.ts` needs nothing to
resolve: an app that only depends on `@guren/core` would otherwise widen the
option to `any` under `skipLibCheck` and check nothing at all.
