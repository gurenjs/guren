import type { Application } from '@guren/server'

/**
 * Create a minimal test application for plugin integration testing.
 * Boots the app with the given providers and returns the booted instance.
 *
 * @example
 * ```typescript
 * import { createPluginTestApp, assertPluginRegisters } from '@guren/testing'
 * import { AnalyticsServiceProvider } from 'guren-plugin-analytics'
 *
 * const app = await createPluginTestApp([AnalyticsServiceProvider])
 * assertPluginRegisters(app, ['analytics'])
 * ```
 */
export async function createPluginTestApp(
  providers: unknown[]
): Promise<Application> {
  // @ts-ignore -- @guren/core is not a dependency; see test-app.ts
  const { createApp } = await import('@guren/core')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = (createApp as any)({ providers })
  await app.boot()
  return app
}

/**
 * Assert that a plugin registers expected services in the container.
 * Throws a descriptive error if any expected service is not bound.
 *
 * @example
 * ```typescript
 * const app = await createPluginTestApp([CacheServiceProvider])
 * assertPluginRegisters(app, ['cache'])
 * ```
 */
export function assertPluginRegisters(
  app: Application,
  services: string[]
): void {
  for (const service of services) {
    const bound = app.container?.has(service) ?? false
    if (!bound) {
      throw new Error(
        `Plugin did not register expected service: "${service}". ` +
          `Verify that the provider calls this.container.singleton("${service}", ...) ` +
          `or this.container.bind("${service}", ...) in its register() method.`
      )
    }
  }
}

/**
 * Assert that a plugin does NOT register certain services.
 * Useful for testing deferred providers before their services are requested.
 *
 * @example
 * ```typescript
 * const app = await createPluginTestApp([DeferredProvider])
 * assertPluginDoesNotRegister(app, ['lazy-service'])
 * ```
 */
export function assertPluginDoesNotRegister(
  app: Application,
  services: string[]
): void {
  for (const service of services) {
    const bound = app.container?.has(service) ?? false
    if (bound) {
      throw new Error(
        `Plugin unexpectedly registered service: "${service}". ` +
          `If this is a deferred provider, the service should not be bound until first resolution.`
      )
    }
  }
}
