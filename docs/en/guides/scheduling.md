# Task Scheduling Guide

Guren provides a fluent API for defining scheduled tasks within your application. Instead of managing multiple cron entries, you can define your entire task schedule in code.

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

### Running on One Server

For multi-server deployments, ensure task runs on only one server:

```ts
schedule.call(task)
  .daily()
  .runOnOneServer()            // Requires distributed lock (Redis)
```

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

Run the scheduler from the command line:

```bash
# Start the scheduler
bunx guren schedule:work

# Start with custom timezone
bunx guren schedule:work --timezone=Asia/Tokyo

# List scheduled tasks
bunx guren schedule:list

# Run a specific task immediately
bunx guren schedule:run cleanup-sessions
```

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
