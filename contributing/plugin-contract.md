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
| Official (Guren team) | `@guren/plugin-{name}` | `@guren/plugin-sentry` |
| Community | `guren-plugin-{name}` | `guren-plugin-stripe` |

The class itself should follow the `{Name}ServiceProvider` pattern (e.g., `SentryServiceProvider`, `StripeServiceProvider`).

## Required Exports

Every plugin package must export:

1. **Default ServiceProvider class** -- the primary export consumers pass to `createApp({ providers })`.

```typescript
// src/index.ts
export { AnalyticsServiceProvider } from './AnalyticsServiceProvider'
```

### Optional: `definePlugin()` Helper

For plugins that accept configuration, expose a factory function:

```typescript
import type { AnalyticsConfig } from './types'

export function definePlugin(config: AnalyticsConfig) {
  return class ConfiguredAnalyticsProvider extends AnalyticsServiceProvider {
    register(): void {
      this.container.singleton('analytics', () => new AnalyticsClient(config))
    }
  }
}
```

Users can then use:

```typescript
import { definePlugin } from 'guren-plugin-analytics'

createApp({
  providers: [
    definePlugin({ apiKey: 'sk_...' }),
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
    "compatibility": ">=0.2.0"
  },
  "peerDependencies": {
    "@guren/core": ">=0.2.0"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `gurenPlugin.compatibility` | semver range | Guren versions this plugin supports |

The framework may read this field at boot time to warn about incompatible plugins.

## What Plugins CAN Do

Plugins interact with the framework exclusively through the public `Container` and `ServiceProvider` APIs:

- **Register services** in the container (`this.container.singleton()`, `.bind()`, `.instance()`)
- **Add middleware** by accessing the Hono app instance via `this.container.make('hono')`
- **Subscribe to events** via the EventManager (`this.container.make('events')`)
- **Extend the container** with new bindings, aliases, and tags
- **Add CLI commands** by registering them through the container
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
