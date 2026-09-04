import type { Application, ServiceProviderConstructor } from '@guren/server'

/** Boot a minimal test application with the given providers. */
export async function createPluginTestApp(
  providers: unknown[]
): Promise<Application> {
  const { createApp } = await import('@guren/core')
  // Callers pass provider classes without having to name the framework type,
  // which `createApp` does demand; a real provider satisfies both.
  const app = createApp({ providers: providers as ServiceProviderConstructor[] })
  await app.boot()
  return app
}

/** Assert a plugin bound the expected services in the container. */
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

/** Assert a plugin bound none of these services — e.g. a deferred provider. */
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
