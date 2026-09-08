import { ServiceProvider, createScheduler, type Scheduler } from '@guren/core'
import { scheduleTasksKernel } from '../Console/Kernel.js'

/**
 * Feeds the kernel's tasks to the scheduler bound as `scheduler`. A scheduler is
 * not a clock: on a long-lived Bun process call `start()` on it from your
 * bootstrap, and on Workers / Lambda the platform's cron trigger supplies the tick.
 */
export default class SchedulingProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('scheduler', () => {
      // Without a logger, a task that throws is caught by runDueTasks() and discarded.
      const scheduler = createScheduler({ logger: console.log })

      for (const task of scheduleTasksKernel().buildTasks()) {
        scheduler.addTask(task)
      }

      return scheduler
    })
  }

  boot(): void {
    // Eager, so a kernel that throws fails the boot rather than the first firing.
    this.container.make<Scheduler>('scheduler')
  }
}
