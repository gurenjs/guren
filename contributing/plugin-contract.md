# Plugin Contract

This document defines the contract that all Guren plugins must follow. A **plugin** is a distributable package that extends Guren through the ServiceProvider system.

## What Is a Plugin?

A Guren plugin is a `ServiceProvider` subclass packaged as an npm module. It participates in the framework lifecycle through two hooks:

| Hook | Phase | Purpose |
|------|-------|---------|
| `register()` | Registration | Bind services into the Container (singletons, factories, instances) |
| `boot()` | Boot | Perform post-registration setup (subscribe to events, register middleware, connect to external services) |

The framework calls `register()` on **all** providers first, then `boot()` on all providers. This guarantees that any service your plugin depends on is already bound in the container before `boot()` runs.

## Plugin Interface

Every plugin must export a class that extends `ServiceProvider`:

```typescript
import { ServiceProvider } from '@guren/server'

export class AnalyticsServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('analytics', () => new AnalyticsClient({
      apiKey: process.env.ANALYTICS_API_KEY,
    }))
  }

  boot(): void {
    const events = this.container.make('events')
    events.on('request.completed', (data) => {
      this.container.make<AnalyticsClient>('analytics').track(data)
    })
  }
}
```

### Deferred Providers

Plugins that are expensive to boot can opt into deferred loading. Deferred providers are only instantiated when one of their declared services is first resolved from the container:

```typescript
export class HeavyServiceProvider extends ServiceProvider {
  static deferred = true
  static provides = ['heavy-service']

  register(): void {
    this.container.singleton('heavy-service', () => new HeavyService())
  }
}
```

## Naming Convention

| Scope | Pattern | Example |
|-------|---------|---------|
| Official (Guren team) | `@guren/plugin-{name}` | `@guren/plugin-vercel`, `@guren/plugin-sentry` |
| Community | `guren-plugin-{name}` | `guren-plugin-stripe` |

The primary export should follow the `{name}Plugin` pattern for `definePlugin()` factories (e.g., `sentryPlugin`, `stripePlugin`), or the `{Name}ServiceProvider` pattern for class-based providers (e.g., `SentryServiceProvider`, `StripeServiceProvider`).

## Required Exports

Every plugin package must export one primary entry consumers pass to `createApp({ providers })` — either:

1. **A `definePlugin()` factory** (recommended for configurable plugins; see below), or
2. **A ServiceProvider class** for plugins that need no configuration or full lifecycle control.

```typescript
// src/index.ts
export { analyticsPlugin } from './plugin'
// or
export { AnalyticsServiceProvider } from './AnalyticsServiceProvider'
```

> **Note:** `bunx guren plugin <pkg>` registers the class export named by `gurenPlugin.provider`. The `{PascalPkg}Provider` name heuristic is only used as a fallback for packages with **no `gurenPlugin` manifest at all** (legacy plugins predating the manifest). If a manifest exists but omits `provider` — the case for `definePlugin()` factories, which must be called with their configuration — the CLI does **not** guess a name; it skips automatic registration and prints a reminder to register the export manually in `createApp({ providers })`.
>
> **Official-plugin exception:** the CLI ships a table of official plugins whose primary export is a *zero-config* `definePlugin()` factory (`@guren/plugin-vercel` → `vercelPlugin()`, `@guren/plugin-cloudflare` → `cloudflarePlugin()`) and auto-registers those as call expressions, e.g. `providers: [vercelPlugin()]`. The table exists because the documented flow runs `guren plugin <pkg>` *before* `bun add <pkg>`, when no manifest is readable yet; it is not open to third-party packages. Precedence: an installed manifest that declares `provider` (a stale class-shaped release) always wins over the table, and an existing configured call (e.g. `vercelPlugin({ ... })`) counts as already registered.

### Recommended: the `definePlugin()` Helper

For plugins that accept configuration, use the framework-provided `definePlugin()` helper from `@guren/core` instead of hand-rolling a factory. Each factory call produces an independent provider class with the configuration captured in a closure — never store configuration on a static class property, since statics are shared across registrations:

```typescript
import { definePlugin } from '@guren/core'
import type { AnalyticsConfig } from './types'

export const analyticsPlugin = definePlugin<AnalyticsConfig>({
  name: 'analytics',
  register(container, config) {
    container.singleton('analytics', () => new AnalyticsClient(config))
  },
  boot(container, config) {
    // Optional: post-registration setup
  },
  // Optional: deferred loading, same semantics as ServiceProvider statics
  // deferred: true,
  // provides: ['analytics'],
})
```

Users can then use:

```typescript
import { analyticsPlugin } from 'guren-plugin-analytics'

createApp({
  providers: [
    analyticsPlugin({ apiKey: 'sk_...' }),
  ],
})
```

## Plugin Metadata

Every plugin must declare a `gurenPlugin` field in its `package.json`:

```json
{
  "name": "guren-plugin-analytics",
  "version": "1.0.0",
  "gurenPlugin": {
    "compatibility": ">=1.0.0",
    "provider": "AnalyticsServiceProvider",
    "env": [{ "key": "ANALYTICS_API_KEY", "comment": "Analytics API key" }],
    "publishes": [{ "from": "stubs/analytics.ts", "to": "config/analytics.ts" }]
  },
  "peerDependencies": {
    "@guren/core": ">=1.0.0"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `gurenPlugin.compatibility` | semver range | Guren versions this plugin supports |
| `gurenPlugin.provider` | string | Named class export registered by `bunx guren plugin`; omit for `definePlugin()` factories |
| `gurenPlugin.env` | array | Env keys appended to the app's `.env.example` (and `.env` when present) at install time |
| `gurenPlugin.publishes` | array | Files copied into the app at install time (`config/`, `db/migrations/`, `resources/` targets only) |
| `gurenPlugin.commands` | object | `{ "entry": "./dist/commands.js", "names": ["myplugin:sync"] }` — CLI commands contributed to `guren`. Names must be `:`-namespaced; built-in names win; a name declared by two plugins is dropped for both; the entry module is only imported when a declared command is invoked or renders its own usage |

The manifest is declarative data only — the CLI never imports or executes plugin code during installation. `compatibility` is verified by `bunx guren plugin` at install time and by `bunx guren doctor`; there is no boot-time cost.

## What Plugins CAN Do

Plugins interact with the framework exclusively through the public `Container` and `ServiceProvider` APIs:

- **Register services** in the container (`this.container.singleton()`, `.bind()`, `.instance()`)
- **Add middleware** by accessing the Hono app instance via `this.container.make('hono')`
- **Subscribe to events** via the EventManager (`this.container.make('events')`)
- **Extend the container** with new bindings, aliases, and tags
- **Add CLI commands** by declaring them in the `gurenPlugin.commands` manifest field (see Plugin Metadata); the entry module is imported only when one of the declared commands is invoked
- **Provide route macros** by extending the Router via the container

## What Plugins SHOULD NOT Do

- **Monkey-patch framework internals.** Never modify prototypes or override private methods on `Application`, `Container`, `Router`, or other framework classes.
- **Depend on unexported APIs.** Only import from the public package entry points (`@guren/server`, `@guren/orm`, `@guren/core`). If you import from a deep path like `@guren/server/src/http/Application`, your plugin will break on internal refactors.
- **Assume global state.** Always resolve dependencies from the container rather than importing module-level singletons.
- **Mutate configuration objects.** Read configuration; do not write to shared config references.
- **Block the event loop in `register()` or `boot()`.** Both hooks support async; use `await` for I/O rather than synchronous blocking calls.

## Container Access

The `this.container` property gives plugins full access to the DI container:

```typescript
// Bind a new service
this.container.singleton('my-service', () => new MyService())

// Resolve an existing service
const events = this.container.make('events')

// Check if a service is bound
const hasMail = this.container.has('mail')

// Bind an existing instance
this.container.instance('my-config', { key: 'value' })
```

---

## Plugin Versioning Policy

### Declaring Compatibility

Plugins declare the Guren versions they support via the `gurenPlugin.compatibility` field in `package.json`. Use standard semver ranges:

```json
{
  "gurenPlugin": {
    "compatibility": ">=0.2.0 <1.0.0"
  }
}
```

### Guidelines

| Scenario | Action |
|----------|--------|
| Guren patch release (0.2.x) | Plugins should remain compatible without changes |
| Guren minor release (0.x.0) | Plugins may need updates if they use newly deprecated APIs |
| Guren major release (x.0.0) | Plugins must re-verify compatibility and update the range |

### Official Plugins

Official plugins (`@guren/plugin-*`) are:

- Maintained alongside the framework in the monorepo or dedicated repositories
- Tested in CI against the **current** Guren version on every framework release
- Updated in lockstep with breaking framework changes

### Community Plugins

Community plugins (`guren-plugin-*`) are:

- Maintained independently by their authors
- Responsible for their own compatibility testing
- Encouraged to use `createPluginTestApp()` from `@guren/testing` (see the [Plugin Authoring Guide](../docs/en/guides/plugins.md)) to verify compatibility against new Guren releases

### Deprecation and Breakage

When the framework deprecates a public API:

1. A deprecation notice is published in the release notes at least one minor version before removal.
2. Plugin authors receive advance warning through the `bunx guren doctor` command, which flags deprecated API usage.
3. The deprecated API is removed in the next major version.

Plugin authors should subscribe to Guren release notifications and run their test suite against release candidates.
