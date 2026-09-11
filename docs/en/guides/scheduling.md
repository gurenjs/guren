# Task Scheduling Guide

Guren provides a fluent API for defining scheduled tasks within your application. Instead of managing multiple cron entries, you can define your entire task schedule in code.

The standard vNext path is: import scheduling APIs from `@guren/core`, register schedules centrally, and keep feature code focused on the jobs or commands being scheduled.

## Core Concepts

- **Scheduler** – Manages and runs scheduled tasks at the appropriate times.
- **Schedule** – Builder for defining tasks with a fluent API.
- **ScheduledTask** – Individual task with its schedule and configuration.
- **Cron Expression** – Standard cron syntax for defining when tasks run.

## Basic Usage

### Quick Start

```ts
import { Scheduler } from '@guren/core'

const scheduler = new Scheduler()

scheduler.schedule((schedule) => {
  // Run a callback every day at 3 AM
  schedule.call(async () => {
    await cleanupOldSessions()
  }).daily().at('03:00').name('cleanup-sessions')
})

scheduler.start()
```

### Running the Scheduler

Start the scheduler in your application bootstrap:

```ts
// app.ts
import { Scheduler } from '@guren/core'

const scheduler = new Scheduler({
  timezone: 'Asia/Tokyo',
  checkInterval: 60000, // Check every 60 seconds
  logger: console.log,
})

// Define schedules
scheduler.schedule((schedule) => {
  schedule.call(() => console.log('Hello!')).everyMinute()
})

// Start when app boots
scheduler.start()

// Stop on shutdown
process.on('SIGTERM', () => {
  scheduler.stop()
})
```

### On Serverless Runtimes

`scheduler.start()` needs a long-lived process, which neither Cloudflare Workers nor AWS Lambda has. There the platform's own scheduler supplies the tick and the app only registers tasks:

- **Cloudflare Workers**: the worker `guren cloudflare:build` generates exports a `scheduled` handler; a `triggers.crons` entry in `wrangler.jsonc` drives it. See [Cloudflare Workers Deployment](./cloudflare.md#scheduled-tasks).
- **AWS Lambda**: `createScheduleHandler(scheduler)` from `@guren/core/lambda`, wired to an EventBridge rule. See [Serverless](./serverless.md).

Each firing runs only the tasks due at that moment, so the platform trigger must be at least as frequent as your finest task. `preventOverlapping()` is an in-memory flag on the task, so it does not carry across firings on a runtime that does not keep the process alive. `runOnOneServer()` keeps its claim in the scheduler's `lock`, which outlives the firing when the lock's store does; the default in-process lock does not. `schedule.command()` shells out through `node:child_process` and does not work on Workers, so use `schedule.call()` or `schedule.job()` there.

## Defining Schedules

### Callbacks

```ts
scheduler.schedule((schedule) => {
  schedule.call(async () => {
    // Your task logic
    await sendDailyReports()
  }).daily().at('09:00')
})
```

### Jobs

Dispatch queued jobs on a schedule:

```ts
import { SendWeeklyDigestJob } from '@/app/Jobs/SendWeeklyDigestJob'

scheduler.schedule((schedule) => {
  schedule.job(SendWeeklyDigestJob, { userId: 'all' })
    .weekly()
    .sundays()
    .at('09:00')
})
```

### Shell Commands

```ts
scheduler.schedule((schedule) => {
  schedule.command('bunx guren db:backup')
    .daily()
    .at('02:00')
    .name('database-backup')
})
```

## Frequency Options

### Minutes

```ts
schedule.call(task).everyMinute()        // Every minute
schedule.call(task).everyTwoMinutes()    // Every 2 minutes
schedule.call(task).everyThreeMinutes()  // Every 3 minutes
schedule.call(task).everyFourMinutes()   // Every 4 minutes
schedule.call(task).everyFiveMinutes()   // Every 5 minutes
schedule.call(task).everyTenMinutes()    // Every 10 minutes
schedule.call(task).everyFifteenMinutes()// Every 15 minutes
schedule.call(task).everyThirtyMinutes() // Every 30 minutes
```

### Hours

```ts
schedule.call(task).hourly()             // Every hour at :00
schedule.call(task).hourlyAt(15)         // Every hour at :15
schedule.call(task).everyTwoHours()      // Every 2 hours
schedule.call(task).everyThreeHours()    // Every 3 hours
schedule.call(task).everyFourHours()     // Every 4 hours
schedule.call(task).everySixHours()      // Every 6 hours
```

### Days

```ts
schedule.call(task).daily()              // Every day at midnight
schedule.call(task).dailyAt('13:00')     // Every day at 1 PM
schedule.call(task).at('13:00')          // Alias for dailyAt
schedule.call(task).twiceDaily(1, 13)    // At 1 AM and 1 PM
```

### Weeks

```ts
schedule.call(task).weekly()                   // Every Sunday at midnight
schedule.call(task).weeklyOn(1, '08:00')       // Every Monday at 8 AM

// Day shortcuts
schedule.call(task).daily().sundays()
schedule.call(task).daily().mondays()
schedule.call(task).daily().tuesdays()
schedule.call(task).daily().wednesdays()
schedule.call(task).daily().thursdays()
schedule.call(task).daily().fridays()
schedule.call(task).daily().saturdays()

// Weekdays and weekends
schedule.call(task).daily().weekdays()         // Monday-Friday
schedule.call(task).daily().weekends()         // Saturday-Sunday
```

### Months and Years

```ts
schedule.call(task).monthly()                  // 1st of month at midnight
schedule.call(task).monthlyOn(15, '09:00')     // 15th at 9 AM
schedule.call(task).lastDayOfMonth('18:00')    // Last day at 6 PM
schedule.call(task).quarterly()                // Jan, Apr, Jul, Oct 1st
schedule.call(task).yearly()                   // Jan 1st at midnight
schedule.call(task).yearlyOn(6, 15, '12:00')   // June 15th at noon
```

### Custom Cron

```ts
// Standard cron format: minute hour day-of-month month day-of-week
schedule.call(task).cron('0 */2 * * *')        // Every 2 hours
schedule.call(task).cron('30 9 * * 1-5')       // 9:30 AM weekdays
schedule.call(task).cron('0 0 1,15 * *')       // 1st and 15th at midnight
```

## Task Configuration

### Task Names

```ts
schedule.call(sendReports)
  .daily()
  .name('send-daily-reports')  // Unique identifier for the task
```

### Timezones

```ts
schedule.call(task)
  .daily()
  .at('09:00')
  .tz('Asia/Tokyo')            // Run at 9 AM Tokyo time

// Or using setTimezone
schedule.call(task)
  .daily()
  .setTimezone('America/New_York')
```

### Preventing Overlaps

Prevent a task from running if a previous instance is still executing:

```ts
schedule.call(longRunningTask)
  .everyMinute()
  .preventOverlapping()        // Skip if previous run hasn't finished

// With expiration (auto-unlock after 10 minutes)
schedule.call(task)
  .everyMinute()
  .preventOverlapping(600000)  // 10 minutes in ms
```

The guard is a flag on the task in this process. Without an expiry, a run that hangs blocks every later run until the process restarts; with one, the next due run goes ahead once that many milliseconds have passed, and the hung run finishing later does not disturb it.

### Running on One Server

On a multi-server deployment every server ticks, so a task that must run once per schedule needs a lock the servers share. Pass a `SchedulerLock` to the scheduler and mark the task:

```ts
import { createScheduler, createRedisClient } from '@guren/core'
import { RedisSchedulerLock } from '@guren/core/redis'

const scheduler = createScheduler({
  lock: new RedisSchedulerLock(createRedisClient({ url: process.env.REDIS_URL })),
})

scheduler.schedule((schedule) => {
  schedule.call(task)
    .daily()
    .name('daily-report')
    .runOnOneServer()
})
```

The claim is keyed on the task name and the due minute, so the task needs a `.name()`. It is held for an hour and is not released when the run finishes: a release would let a server whose clock reaches that minute a few seconds later run the task again. A server whose own overlap guard still holds the task never asks for the claim. One that wins it and then declines in `when()` / `skip()` gives it back, so another server can still take that minute.

`MemorySchedulerLock` is the single-process lock, for one server or for tests, and it is what a scheduler given no `lock` uses. On a second server that guards nothing, so the first `runOnOneServer()` task on an implicit lock prints a warning naming `createScheduler({ lock })` and `RedisSchedulerLock`. A task with no `.name()`, or an empty one, is refused when it is registered and again at `start()`: there is nothing to key the claim on. For a store other than Redis, implement `SchedulerLock` yourself: `acquire(key, ttlSeconds)` has to be an atomic set-if-absent with expiry, and `release(key)` deletes the key.

Every key carries the scheduler's `lockPrefix` (`'schedule:'` by default). Two apps sharing one lock store must set distinct prefixes, or a task name they have in common claims one tick between the two of them.

### Conditional Execution

```ts
// Run only if condition is true
schedule.call(task)
  .daily()
  .when(() => process.env.NODE_ENV === 'production')

// Skip if condition is true
schedule.call(task)
  .daily()
  .skip(() => isMaintenanceMode())
```

### Lifecycle Hooks

```ts
schedule.call(sendEmails)
  .daily()
  .at('09:00')
  .before(() => console.log('Starting email send...'))
  .after(() => console.log('Email send complete'))
  .onSuccess(() => metrics.increment('emails.sent'))
  .onFailure((error) => {
    alerting.notify('Email send failed', error)
  })
```

## Scheduler API

```ts
const scheduler = new Scheduler()

// Define tasks
scheduler.schedule((schedule) => { ... })

// Add pre-built task
scheduler.addTask(scheduledTask)

// Start/stop
scheduler.start()
scheduler.stop()

// Check status
scheduler.getIsRunning()

// Get tasks
scheduler.getTasks()                    // All tasks
scheduler.getDueTasks()                 // Tasks due now
scheduler.getTask('task-name')          // Task by name
scheduler.count()                       // Number of tasks

// Manage tasks
scheduler.removeTask('task-name')       // Remove by name
scheduler.clear()                       // Remove all tasks

// Manual execution
await scheduler.runDueTasks()           // Run all due tasks now
```

## CLI Integration

The ticking scheduler lives inside your application — `scheduler.start()`, above.
The CLI covers the other half: seeing what is registered, and driving a run from
outside the process, which is what a system cron or a platform trigger calls.

```bash
# List scheduled tasks
bunx guren schedule:list
bunx guren schedule:list --json

# Run whichever tasks are due now
bunx guren schedule:run

# Run one task immediately, due or not
bunx guren schedule:run --task cleanup-sessions --force
```

### Making tasks visible to the CLI

`schedule:list` and `schedule:run` do not boot your application. They load the
schedule kernel directly, probing `app/Console/Kernel.ts` (and the lowercase and
`src/` variants), or the path given to `--kernel`. Tasks declared anywhere else
are invisible to both commands, however reliably they run under
`scheduler.start()`.

Two export shapes are recognized, each under its own naming convention.

**A registrar** is the shape most app code already has: a provider builds the
scheduler and hands it over, and the CLI supplies one of its own.

```ts
// app/Console/Kernel.ts
import type { Scheduler } from '@guren/core'

export function registerSchedules(scheduler: Scheduler): void {
  scheduler.schedule((schedule) => {
    schedule.call(warmCache).hourly().name('warm-cache')
  })
}
```

Name it `register…Schedules` (`registerSchedules`, `registerBillingSchedules`),
or make it the default export. A kernel may export several, and they all
receive the same scheduler. The convention is what keeps the CLI from calling
every helper the file happens to export; a registrar named anything else is
reported as unrecognized rather than silently skipped.

**A kernel factory** takes nothing and returns the `Schedule` it built. It is
recognized as `scheduleTasksKernel`, `schedule`, `defineSchedule`, or the default
export, and is what `bunx guren add schedule` scaffolds.

```ts
// app/Console/Kernel.ts
import { Schedule } from '@guren/core'

export function scheduleTasksKernel(): Schedule {
  const schedule = new Schedule()
  schedule.call(warmCache).hourly().name('warm-cache')
  return schedule
}
```

A factory declares the tasks but runs nothing on its own: a provider still has
to feed them to the scheduler it binds:

```ts
for (const task of scheduleTasksKernel().buildTasks()) scheduler.addTask(task)
```

Prefer the registrar in application code: it is the same `Scheduler` API the rest
of this guide teaches, and the tasks reach the running scheduler without a second
wiring step.

Either way, resolve services *inside* the task callback rather than while the
kernel is being built. The CLI reads this file without booting your app, so a
container lookup at build time has nothing to resolve:

```ts
schedule.call(() => getContainer().make<SessionManager>('session').pruneExpired()).hourly()
```

A kernel that exists but matches neither shape, or that throws while loading, is
reported as such and exits non-zero, which is not the same state as an app that
has not scheduled anything yet.

## Testing

```ts
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Scheduler, Schedule } from '@guren/core'

describe('Scheduling', () => {
  let scheduler: Scheduler

  beforeEach(() => {
    scheduler = new Scheduler()
  })

  afterEach(() => {
    scheduler.stop()
  })

  test('schedules daily task', () => {
    scheduler.schedule((schedule) => {
      schedule.call(() => {}).daily().at('09:00').name('test-task')
    })

    expect(scheduler.count()).toBe(1)
    expect(scheduler.getTask('test-task')).toBeDefined()
  })

  test('identifies due tasks', () => {
    const mockTask = mock(() => {})

    scheduler.schedule((schedule) => {
      schedule.call(mockTask).everyMinute()
    })

    const dueTasks = scheduler.getDueTasks(new Date())
    expect(dueTasks.length).toBeGreaterThan(0)
  })

  test('runs due tasks', async () => {
    let executed = false

    scheduler.schedule((schedule) => {
      schedule.call(() => { executed = true }).everyMinute()
    })

    await scheduler.runDueTasks()

    expect(executed).toBe(true)
  })

  test('respects when condition', async () => {
    let executed = false

    scheduler.schedule((schedule) => {
      schedule.call(() => { executed = true })
        .everyMinute()
        .when(() => false)  // Never run
    })

    await scheduler.runDueTasks()

    expect(executed).toBe(false)
  })
})
```

## Best Practices

1. **Name your tasks**: Always use `.name()` for easier debugging and management.

2. **Use appropriate frequencies**: Don't schedule tasks more often than needed.

3. **Set timezones explicitly**: Avoid ambiguity by setting timezone for time-sensitive tasks.

4. **Prevent overlapping for long tasks**: Use `.preventOverlapping()` for tasks that may take longer than their interval.

5. **Handle failures gracefully**: Use `.onFailure()` to log errors and send alerts.

6. **Test schedules**: Write tests to verify your task scheduling logic.

7. **Monitor task execution**: Log task runs and track success/failure metrics.

8. **Use jobs for heavy work**: Dispatch jobs instead of running heavy tasks directly in the scheduler.
