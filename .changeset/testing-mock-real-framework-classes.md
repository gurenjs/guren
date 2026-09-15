---
"@guren/server": minor
"@guren/testing": minor
---

`createControllerModuleMock()` now installs the framework's own `Resource`, `JsonResource`, `collect`, `ValidationException`, `AuthenticationException`, `ServiceProvider`, `defineModule` and `definePlugin` instead of hand-written copies.

The copies had drifted from the runtime, so a mocked controller test could pass on behavior production does not have:

- `validateParams()` failed with status **400** under the mock; the runtime answers **422**. A test asserting `statusCode: 400` for an invalid route parameter now fails and should expect 422.
- `validateBody()` / `validateQuery()` / `validateParams()` keyed a root-level issue (empty path) `message` where the runtime keys it `''`, and they and their `*Safe()` variants added a `message` entry to an issue-less failure, which the runtime does not.
- The exceptions did not extend `HttpException`, so `toResponse()`, `toJSON()`, `getFieldErrors()`, `guard`, `redirectTo` and `withRedirect()` were missing.
- `Resource` lacked `whenOr()`, `whenNotNull()` and `merge()`.
- `ServiceProvider` had a concrete `boot()`, a public `container`, and no `deferred` / `provides`; `defineModule()` dropped `commands`.

The mock reads them through the new internal `@guren/server/internal/testing` subpath, because suites install the mock as `@guren/server` itself. The classes are the ones `@guren/core` exports, so `instanceof` agrees with the framework.
