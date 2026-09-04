import { describe, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { listScheduledTasks, runScheduledTasks } from '../src/schedule'

describe('schedule', () => {
  const testDir = resolve(import.meta.dir, '.test-schedule')
  const kernelDir = join(testDir, 'app/Console')
  const kernelPath = join(kernelDir, 'Kernel.ts')

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true })
    }
    mkdirSync(kernelDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true })
    }
  })

  describe('listScheduledTasks', () => {
    test('shows message when no kernel file exists', async () => {
      await listScheduledTasks({ appRoot: testDir })
    })

    test('loads tasks from kernel file', async () => {
      const kernelContent = `
export class Schedule {
  private tasks = []

  call(callback) {
    const pending = {
      expression: '* * * * *',
      name: 'test-task',
      daily() {
        this.expression = '0 0 * * *'
        return this
      },
      name(n) {
        this.taskName = n
        return this
      },
      toTask() {
        return {
          name: this.taskName || 'unnamed',
          expression: this.expression,
        }
      }
    }
    this.tasks.push(pending)
    return pending
  }

  buildTasks() {
    return this.tasks.map(t => t.toTask())
  }
}

export function scheduleTasksKernel() {
  const schedule = new Schedule()
  schedule.call(() => {}).daily().name('daily-task')
  return schedule
}
`
      writeFileSync(kernelPath, kernelContent)

      await listScheduledTasks({ appRoot: testDir })
    })
  })

  describe('runScheduledTasks', () => {
    test('shows message when no kernel file exists', async () => {
      await runScheduledTasks({ appRoot: testDir })
    })

    test('can filter by task name', async () => {
      const kernelContent = `
export class Schedule {
  private tasks = []

  call(callback) {
    const pending = {
      expression: '* * * * *',
      taskName: null,
      daily() {
        this.expression = '0 0 * * *'
        return this
      },
      name(n) {
        this.taskName = n
        return this
      },
      toTask() {
        return {
          name: this.taskName || 'unnamed',
          expression: this.expression,
        }
      }
    }
    this.tasks.push(pending)
    return pending
  }

  buildTasks() {
    return this.tasks.map(t => t.toTask())
  }
}

export function scheduleTasksKernel() {
  const schedule = new Schedule()
  schedule.call(() => {}).daily().name('task-1')
  schedule.call(() => {}).daily().name('task-2')
  return schedule
}
`
      writeFileSync(kernelPath, kernelContent)

      await runScheduledTasks({ appRoot: testDir, task: 'task-1' })
    })

    test('can force run tasks', async () => {
      const kernelContent = `
export class Schedule {
  private tasks = []

  call(callback) {
    const pending = {
      expression: '* * * * *',
      taskName: null,
      daily() {
        this.expression = '0 0 * * *'
        return this
      },
      name(n) {
        this.taskName = n
        return this
      },
      toTask() {
        return {
          name: this.taskName || 'unnamed',
          expression: this.expression,
        }
      }
    }
    this.tasks.push(pending)
    return pending
  }

  buildTasks() {
    return this.tasks.map(t => t.toTask())
  }
}

export function scheduleTasksKernel() {
  const schedule = new Schedule()
  schedule.call(() => {}).daily().name('forced-task')
  return schedule
}
`
      writeFileSync(kernelPath, kernelContent)

      await runScheduledTasks({ appRoot: testDir, force: true })
    })
  })
})
