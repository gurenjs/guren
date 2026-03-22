import type { Scheduler } from '@guren/core'

export function registerApiSchedules(scheduler: Scheduler): void {
  scheduler.schedule((schedule) => {
    schedule
      .call(async () => {
        console.log('[Schedule] pruning completed task cache')
      })
      .daily()
      .at('03:00')
      .name('api:prune-task-cache')
  })
}
