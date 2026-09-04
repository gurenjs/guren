import { ServiceProvider } from '../container/ServiceProvider'
import { createScheduler } from '../scheduling'

/** Binds the Scheduler as a singleton in the container. */
export class SchedulingServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('scheduler', () => createScheduler())
  }
}
