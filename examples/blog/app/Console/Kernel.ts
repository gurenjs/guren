import type { Scheduler } from '@guren/core'

export function registerBlogSchedules(scheduler: Scheduler): void {
  scheduler.schedule((schedule) => {
    schedule
      .call(async () => {
        console.log('[Schedule] warming post cache')
      })
      .hourly()
      .name('blog:warm-post-cache')
  })
}
