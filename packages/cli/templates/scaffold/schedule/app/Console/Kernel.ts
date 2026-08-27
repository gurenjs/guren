import { Schedule } from '@guren/core'

export function scheduleTasksKernel(): Schedule {
  const schedule = new Schedule()

  schedule
    .call(async () => {
      console.log('[Schedule] Running heartbeat task')
    })
    .hourly()
    .name('app-heartbeat')

  return schedule
}

export default scheduleTasksKernel
