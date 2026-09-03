# Plugin Authoring Guide

This guide walks you through creating, testing, and publishing a Guren plugin.

## What Is a Plugin?

A Guren plugin is an npm package that exports a `ServiceProvider` subclass. When users add your provider to their `createApp({ providers })` array, the framework calls your `register()` and `boot()` hooks during application startup.

For the full contract and rules, see [Plugin Contract](../../../contributing/plugin-contract.md).

## Step 1: Create a New Package

```bash
mkdir guren-plugin-analytics
cd guren-plugin-analytics
bun init
```

Set up your `package.json`:

```json
{
  "name": "guren-plugin-analytics",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.mjs",
  "types": "dist/index.d.mts",
  "gurenPlugin": {
    "compatibility": ">=1.0.0"
  },
  "peerDependencies": {
    "@guren/core": ">=1.0.0"
  },
  "devDependencies": {
    "@guren/core": "^1.0.0",
    "@guren/testing": "^1.0.0",
    "typescript": "^5.0.0"
  }
}
```

Key points:
- `@guren/core` is a **peer dependency** -- the host application provides it.
- `@guren/core` and `@guren/testing` are **dev dependencies** for building and testing.
- The `gurenPlugin.compatibility` field declares which Guren versions your plugin supports.

## Step 2: Define the Plugin

Use the `definePlugin()` helper from `@guren/core`. It captures your configuration in a closure and returns a factory that produces an independent provider class per call, so the same plugin can be registered twice with different configurations:

```typescript
// src/plugin.ts
import { definePlugin } from '@guren/core'

export interface AnalyticsConfig {
  apiKey: string
  endpoint?: string
  batchSize?: number
}

export class AnalyticsClient {
  constructor(private config: AnalyticsConfig) {}

  track(event: string, properties?: Record<string, unknown>): void {
    // Send analytics event to the configured endpoint
    console.log(`[Analytics] ${event}`, properties)
  }
}

export const analyticsPlugin = definePlugin<AnalyticsConfig>({
  name: 'analytics',

  register(container, config) {
    container.singleton('analytics', () => new AnalyticsClient(config))
  },

  boot(container) {
    // Subscribe to framework events after all providers are registered
    if (container.has('events')) {
      const events = container.make('events')
      const analytics = container.make<AnalyticsClient>('analytics')
      events.on('request.completed', (data: Record<string, unknown>) => {
        analytics.track('page_view', data)
      })
    }
  },
})
```

Plugins that are expensive to initialize can pass `deferred: true` together with `provides: ['analytics']` so the provider only loads when one of its services is first resolved. Because `container.make()` is synchronous, a deferred plugin's `register()` must bind its services synchronously (`make()` throws if it does not); `boot()` may still be async and runs right after that first resolution.

If you need lifecycle behavior beyond what `definePlugin()` covers, you can still export a `ServiceProvider` subclass directly — the class-based contract is unchanged. Avoid storing configuration on a static class property, though: statics are shared, so registering the plugin twice would silently overwrite the first configuration.

## Step 3: Export the Plugin

```typescript
// src/index.ts
export { analyticsPlugin, AnalyticsClient } from './plugin'
export type { AnalyticsConfig } from './plugin'
```

## Step 4: Add Plugin Metadata

Your `package.json` must include the `gurenPlugin` field:

```json
{
  "gurenPlugin": {
    "compatibility": ">=1.0.0",
    "provider": "AnalyticsServiceProvider",
    "env": [
      { "key": "ANALYTICS_API_KEY", "comment": "Analytics service API key" }
    ],
    "publishes": [
      { "from": "stubs/analytics.ts", "to": "config/analytics.ts" }
    ]
  }
}
```

| Field | Purpose |
|-------|---------|
| `compatibility` | Semver range of Guren versions your plugin supports. Verified by `bunx guren plugin` at install time and by `bunx guren doctor`. |
| `provider` | Named class export for `bunx guren plugin` to register in `createApp({ providers })`. Omit for `definePlugin()` factories (registered manually). |
| `env` | Env keys appended to the app's `.env.example` (and `.env` when present) at install time. |
| `publishes` | Files copied from your package into the app (`config/`, `db/migrations/`, or `resources/` only). Existing files are never overwritten without `--force`. |

The manifest is pure data — the CLI never executes plugin code during installation.

### Optional: Contribute CLI Commands

Plugins can add commands to the `guren` CLI by declaring them in the manifest:

```json
{
  "gurenPlugin": {
    "commands": {
      "entry": "./dist/commands.mjs",
      "names": ["analytics:flush"]
    }
  }
}
```

The entry module default-exports a record of citty command definitions keyed by command name:

```typescript
// src/commands.ts
import { defineCommand } from 'citty'

export default {
  'analytics:flush': defineCommand({
    meta: { name: 'analytics:flush', description: 'Flush queued analytics events' },
    async run() {
      // ...
    },
  }),
}
```

Once the plugin is installed in an app, `bunx guren analytics:flush` runs the command and `bunx guren --help` lists it. Names must contain a `:` namespace, built-in command names always win, and a name declared by two plugins is dropped for both with a warning. The entry module is imported only when one of the declared commands is invoked (or renders its own `--help`) — never for the root listing.

## Step 5: Write Tests

Use `createPluginTestApp` and `assertPluginRegisters` from `@guren/testing`:

```typescript
// src/plugin.test.ts
import { describe, test, expect } from 'bun:test'
import { createPluginTestApp, assertPluginRegisters } from '@guren/testing'
import { analyticsPlugin, AnalyticsClient } from './plugin'

describe('analyticsPlugin', () => {
  test('should register the analytics service', async () => {
    const app = await createPluginTestApp([analyticsPlugin({ apiKey: 'test-key' })])

    // Verify the service is bound
    assertPluginRegisters(app, ['analytics'])
  })

  test('should resolve an AnalyticsClient instance', async () => {
    const app = await createPluginTestApp([analyticsPlugin({ apiKey: 'test-key' })])

    const client = app.container.make<AnalyticsClient>('analytics')
    expect(client).toBeInstanceOf(AnalyticsClient)
  })

  test('should register as a singleton', async () => {
    const app = await createPluginTestApp([analyticsPlugin({ apiKey: 'test-key' })])

    const first = app.container.make<AnalyticsClient>('analytics')
    const second = app.container.make<AnalyticsClient>('analytics')
    expect(first).toBe(second)
  })
})
```

Run the tests:

```bash
bun test src/plugin.test.ts
```

## Step 6: Build

Add a build script using [`tsdown`](https://tsdown.dev) (it emits `dist/index.mjs` and `dist/index.d.mts`, matching the `main`/`types` above):

```json
{
  "scripts": {
    "build": "tsdown src/index.ts --dts",
    "test": "bun test"
  },
  "devDependencies": {
    "tsdown": "^0.22.0"
  }
}
```

## Step 7: Test Locally Before Publishing

Link the plugin into a real Guren app to verify it end to end before publishing:

```bash
# from your app's directory
bun add file:../guren-plugin-analytics
bunx guren plugin guren-plugin-analytics
```

`bun add file:` (and the `link:`/`workspace:` protocols) install the package as symlinks back to your plugin's source directory instead of copying it. If your plugin's `package.json` still has its own `node_modules` installed — from adding `@guren/core` as a `devDependency` in Step 1 — the app can end up loading two separate copies of `@guren/core`: one from its own install, one through the plugin's. This shows up as duplicate-module warnings at runtime, or a TypeScript error like `Property 'bindings' is protected but type 'Container' is not a class derived from 'Container'` at compile time.

If you hit this, delete `node_modules` inside your plugin's package directory before linking it into the app — the app's own `@guren/core` install then satisfies the plugin's `peerDependencies` with nothing left to shadow it. A published plugin never ships its `node_modules`, so this only affects local testing before publishing.

## Step 8: Publish

```bash
bun run build
npm publish
```

## Installing Plugins

Any plugin — official (`@guren/plugin-*`) or community (`guren-plugin-*`) — can be installed via the CLI:

```bash
bunx guren plugin @guren/plugin-vercel
```

The `plugin` command installs the package with `bun add` when missing (pass `--no-install` to skip), verifies the plugin's declared Guren compatibility (`--ignore-compatibility` to register anyway), adds the provider import, registers it in `createApp({ providers })`, and applies any `env` and `publishes` entries from the plugin's `gurenPlugin` manifest. `--force` overwrites already-published files.

> **Note:** Automatic registration covers class-based provider exports and the official zero-config factory plugins (`@guren/plugin-vercel`, `@guren/plugin-cloudflare`), which are registered as `providers: [vercelPlugin()]`-style calls. Third-party plugins built with `definePlugin()` export a factory that must be called with its configuration, so register them manually in `createApp({ providers })` as shown below.

## Usage in a Guren Application

Once published, users install and register the plugin:

```bash
bun add guren-plugin-analytics
```

```typescript
// src/app.ts
import { createApp } from '@guren/core'
import { analyticsPlugin } from 'guren-plugin-analytics'
import { registerWebRoutes } from '@/routes/web'

export const app = createApp({
  routes: registerWebRoutes,
  providers: [
    analyticsPlugin({
      apiKey: process.env.ANALYTICS_API_KEY!,
      endpoint: 'https://analytics.example.com',
    }),
  ],
})
```

## Complete Example: Request Logger Plugin

A minimal plugin that logs every incoming request:

```typescript
// src/RequestLoggerProvider.ts
import { ServiceProvider } from '@guren/core'
import type { Hono, MiddlewareHandler } from 'hono'

export class RequestLoggerProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('request-logger', () => {
      return {
        requests: [] as Array<{ method: string; path: string; timestamp: number }>,
      }
    })
  }

  boot(): void {
    const hono = this.container.make<Hono>('hono')
    const logger = this.container.make<{ requests: Array<{ method: string; path: string; timestamp: number }> }>('request-logger')

    const middleware: MiddlewareHandler = async (c, next) => {
      logger.requests.push({
        method: c.req.method,
        path: c.req.path,
        timestamp: Date.now(),
      })
      await next()
    }

    hono.use('*', middleware)
  }
}
```

Test it:

```typescript
import { describe, test, expect } from 'bun:test'
import { createPluginTestApp, assertPluginRegisters } from '@guren/testing'
import { RequestLoggerProvider } from './RequestLoggerProvider'

describe('RequestLoggerProvider', () => {
  test('should register request-logger service', async () => {
    const app = await createPluginTestApp([RequestLoggerProvider])
    assertPluginRegisters(app, ['request-logger'])
  })

  test('should initialize with empty request log', async () => {
    const app = await createPluginTestApp([RequestLoggerProvider])
    const logger = app.container.make<{ requests: unknown[] }>('request-logger')
    expect(logger.requests).toHaveLength(0)
  })
})
```

## Tips

- **Keep `register()` synchronous when possible.** Both hooks support async, but synchronous registration is faster.
- **Use deferred providers for heavy dependencies.** If your plugin loads a large SDK, mark the provider as deferred so it only initializes when needed.
- **Depend on the container, not imports.** Resolve services via `this.container.make()` rather than importing framework internals directly.
- **Test against multiple Guren versions.** Use a CI matrix to run your test suite against the minimum and latest supported versions.
- **Document the services you register.** Users need to know what container keys your plugin provides so they can resolve them in their own code.
