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

  // `read()` already treats an expired session as missing, so this only keeps
  // the table from growing (RFC 0020 §2).
  scheduler.schedule((schedule) => {
    schedule.command('sessions:prune').dailyAt('03:00').name('sessions:prune')
  })
}
