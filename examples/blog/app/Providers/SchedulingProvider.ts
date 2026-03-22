import { ServiceProvider, createScheduler, type Scheduler } from '@guren/core'
import { registerBlogSchedules } from '../Console/Kernel.js'

let scheduler: Scheduler | null = null

export function getScheduler(): Scheduler {
  if (!scheduler) {
    scheduler = createScheduler({
      timezone: 'Asia/Tokyo',
    })
    registerBlogSchedules(scheduler)
  }

  return scheduler
}

export default class SchedulingProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('scheduler', () => getScheduler())
  }

  boot(): void {
    this.container.make<Scheduler>('scheduler')
  }
}
