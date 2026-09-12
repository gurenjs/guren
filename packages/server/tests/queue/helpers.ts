import { Application } from '../../src/http/Application'
import { resetDefaultApplication } from '../../src/http/default-application'
import type { ServiceProviderConstructor } from '../../src/container/ServiceProvider'
import { QueueServiceProvider } from '../../src/providers/QueueServiceProvider'
import type { MemoryDriver } from '../../src/queue'
import { clearQueueDriver } from '../../src/queue'

/** A booted app whose `queue` manager resolves `driver` under the default name. */
export async function bootWithMemoryQueue(
  driver: MemoryDriver,
  providers: ServiceProviderConstructor[] = [],
): Promise<Application> {
  const app = new Application({ providers: [...providers, QueueServiceProvider] })
  await app.boot()
  app.container.make('queue').registerDriver('memory', () => driver)
  return app
}

/**
 * The process-wide state a queue test leaves behind: the `Job.dispatch()` pin
 * and the ambient application. A test that keeps either hands the next file an
 * app it never booted.
 */
export function resetQueueState(): void {
  clearQueueDriver()
  resetDefaultApplication()
}
