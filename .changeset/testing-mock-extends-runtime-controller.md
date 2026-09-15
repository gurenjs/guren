---
"@guren/server": patch
"@guren/testing": minor
---

The `Controller` that `createControllerModuleMock()` installs now extends the framework's own `Controller` instead of re-implementing its helpers, so a mocked controller test runs the request, validation and response code production runs. It overrides only what needs a booted application: `inertia()` still renders without shared props, a root document or an asset manifest, and `make()` still resolves from the context's `var.container`.

Helpers the copy lacked are now present: `accepted()`, `only()`, `except()`, `has()`, `query()`, `authorize()`, `can()`, `locale`, `t()`, `tc()` and `model()`.

Behavior that changes, each toward what the runtime already does:

- `redirect()` sends the `headers` option. The copy dropped it.
- A schema failure whose error carries no `issues` throws a `TypeError`, as in production. The copy answered 422.
- `this.auth` throws when no auth context is set, and cannot be assigned, because it is a getter. Stub it with `Object.defineProperty(controller, 'auth', { value: stub })`; `controller.auth = stub` and `Object.assign(controller, { auth: stub })` now throw.
- `inertia()` returns a promise and sets `Vary: Accept`.
- `validateBody()` reuses the body a route contract already parsed, when `contractInput()` seeded one.

The mock-only members are gone: `parsedBody`, `rawBody`, `multipartBody`, `readMultipart()`, `getBody()`, `getRawBody()`, `runValidation()`, `runValidationSafe()` and the public `context` field. The runtime keeps its parsed body privately under the same names, so they cannot remain on a subclass. `ctx`, `request`, `json()`, `validateBody()` and the other helpers are `protected`, as on the runtime class; call them from an action on your controller subclass rather than on the instance. Tests that only call `setContext()` and an action need no change.

`createControllerContext()` changes to match a live request: `req.param()` answers `{}` rather than `undefined` when a test sets no parameters, `req.json()` and `req.parseBody()` read through one `HonoRequest` so a body read twice in an action hits Hono's cache, and `var` exposes the context values alongside `container`.

The runtime class is reached through the internal `@guren/server/internal/testing` subpath, which now exports `Controller`.
