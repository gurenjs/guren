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
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
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

Plugins that are expensive to initialize can pass `deferred: true` together with `provides: ['analytics']` so the provider only loads when one of its services is first resolved.

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
    "compatibility": ">=1.0.0"
  }
}
```

This tells Guren (and other tooling) which framework versions your plugin is designed for.

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

Add a build script using `tsup`:

```json
{
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "test": "bun test"
  },
  "devDependencies": {
    "tsup": "^8.0.0"
  }
}
```

## Step 7: Publish

```bash
bun run build
npm publish
```

## Installing Official Plugins

Official plugins (`@guren/plugin-*`) can be installed via the CLI, which patches `src/app.ts` and scaffolds any extra files automatically:

```bash
bunx guren plugin @guren/plugin-vercel
bun add @guren/plugin-vercel
```

The `plugin` command adds the provider import and registers it in `createApp({ providers })` for you.

> **Note:** Automatic registration currently supports class-based provider exports only. Plugins built with `definePlugin()` export a factory that must be called with its configuration, so register them manually in `createApp({ providers })` as shown below.

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
