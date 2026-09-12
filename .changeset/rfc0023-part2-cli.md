---
"@guren/cli": minor
---

Register RFC 0023's deprecations and ship the codemod that migrates them

`bunx guren upgrade --check-only` reports `global-service-setters` and
`global-service-getters`, naming every file that imports one of the module-level
service accessors deprecated in `@guren/server` 2.23.0. Detection reads a wider
file set than the other entries: `config/`, `src/` and `app/` of the app and its
modules, plus test files, because the setters live in `src/app.ts` and
`config/*.ts` and the test-injection row of the migration table is reported
rather than rewritten.

`bunx guren upgrade` applies the `container-only-service-resolution` codemod,
the first entry in the codemod registry. It is AST-based, idempotent, and
covers the Migration Path table:

- a deprecated getter inside a `ServiceProvider` becomes `this.container.make(key)`, and `getContainer()` there becomes `this.container`
- a deprecated setter whose key a provider in the same file binds is deleted; one in a provider that binds nothing becomes `this.container.instance(key, value)`
- `setInertiaDocument({ … })` with an inline literal moves into `createApp({ inertia: { document } })` when `createApp` is in the same file, comment included
- the attachments `storage` factory becomes `(container) => container.make('storage')`
- `getContainer().make(key)` inside a `Job` becomes `this.make(key)`
- unused `@guren/core` / `@guren/server` import specifiers left behind are removed

Test injections through `setGate()` or `setQueueDriver()` are reported only:
the replacement depends on which application the fake belongs to.

`guren queue:work` resolves its fallback driver through the new internal
`resolveQueueDriver()`, so booting an app for the worker no longer prints a
deprecation warning for a call the CLI made itself.
