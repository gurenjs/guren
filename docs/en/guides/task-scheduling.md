# Task Scheduling

Guren provides a powerful task scheduler that allows you to define scheduled tasks using fluent, expressive syntax. Schedule tasks to run at specific intervals without needing external cron daemons.

## Configuration

Create a scheduler and define your scheduled tasks:

```typescript
import { createScheduler, Schedule } from '@guren/core'

const scheduler = createScheduler({
  timezone: 'America/New_York',
  checkInterval: 60000, // Check every minute (default)
})

// Define schedules
const schedule = new Schedule()

schedule.call(async () => {
  console.log('Running every minute')
}).everyMinute()

schedule.call(async () => {
  console.log('Running daily at midnight')
}).daily()

// Add tasks to scheduler
for (const task of schedule.buildTasks()) {
  scheduler.addTask(task)
}

// Start the scheduler
scheduler.start()
```

## Defining Schedules

### Scheduling Callbacks

```typescript
const schedule = new Schedule()

// Simple callback
schedule.call(async () => {
  await sendDailyReport()
}).daily()

// With parameters from closure
const userId = 123
schedule.call(async () => {
  await processUserData(userId)
}).hourly()
```

### Scheduling Jobs

```typescript
import { SendNewsletterJob } from '../Jobs/SendNewsletterJob'

// Dispatch a job on a schedule
schedule.job(SendNewsletterJob, { subscriberCount: 1000 }).weekly()
```

### Scheduling Shell Commands

```typescript
// Run a shell command
schedule.command('npm run cleanup').daily()

schedule.command('pg_dump mydb > backup.sql').dailyAt('03:00')
```

## Schedule Frequency Options

### Common Frequencies

```typescript
// Every minute
schedule.call(task).everyMinute()

// Every X minutes
schedule.call(task).everyTwoMinutes()
schedule.call(task).everyThreeMinutes()
schedule.call(task).everyFourMinutes()
schedule.call(task).everyFiveMinutes()
schedule.call(task).everyTenMinutes()
schedule.call(task).everyFifteenMinutes()
schedule.call(task).everyThirtyMinutes()

// Hourly
schedule.call(task).hourly()
schedule.call(task).hourlyAt(15) // At minute 15

// Every X hours
schedule.call(task).everyTwoHours()
schedule.call(task).everyThreeHours()
schedule.call(task).everyFourHours()
schedule.call(task).everySixHours()

// Daily
schedule.call(task).daily()           // At midnight
schedule.call(task).dailyAt('13:00')  // At 1 PM
schedule.call(task).at('09:30')       // Alias for dailyAt
schedule.call(task).twiceDaily(1, 13) // At 1 AM and 1 PM

// Weekly
schedule.call(task).weekly()                  // Sunday at midnight
schedule.call(task).weeklyOn(1, '08:00')      // Monday at 8 AM

// Monthly
schedule.call(task).monthly()                 // 1st at midnight
schedule.call(task).monthlyOn(15, '09:00')    // 15th at 9 AM
schedule.call(task).lastDayOfMonth('23:59')   // Last day

// Quarterly and Yearly
schedule.call(task).quarterly()               // Jan, Apr, Jul, Oct 1st
schedule.call(task).yearly()                  // January 1st
schedule.call(task).yearlyOn(6, 15, '12:00')  // June 15th at noon
```

### Day of Week Constraints

```typescript
// Specific days
schedule.call(task).daily().sundays()
schedule.call(task).daily().mondays()
schedule.call(task).daily().tuesdays()
schedule.call(task).daily().wednesdays()
schedule.call(task).daily().thursdays()
schedule.call(task).daily().fridays()
schedule.call(task).daily().saturdays()

// Day groups
schedule.call(task).daily().weekdays()  // Monday-Friday
schedule.call(task).daily().weekends()  // Saturday-Sunday
```

### Custom Cron Expressions

```typescript
// Use raw cron expression
schedule.call(task).cron('0 */6 * * *')  // Every 6 hours

// Standard cron format: minute hour day month weekday
schedule.call(task).cron('30 9 * * 1-5')  // 9:30 AM weekdays
```

## Task Configuration

### Task Names

```typescript
schedule.call(task)
  .daily()
  .name('daily-report')
```

### Timezone

```typescript
schedule.call(task)
  .dailyAt('09:00')
  .tz('Asia/Tokyo')

// Or use setTimezone alias
schedule.call(task)
  .dailyAt('09:00')
  .setTimezone('Europe/London')
```

### Preventing Overlaps

Prevent a task from running if a previous instance is still running:

```typescript
schedule.call(longRunningTask)
  .everyMinute()
  .preventOverlapping()

// With expiration time (in minutes)
schedule.call(longRunningTask)
  .everyMinute()
  .withoutOverlaps(60) // Lock expires after 60 minutes
```

### Single Server Execution

For distributed environments, ensure a task runs on only one server:

```typescript
schedule.call(task)
  .daily()
  .runOnOneServer()
```

### Conditional Execution

```typescript
// Run only when condition is true
schedule.call(task)
  .daily()
  .when(() => process.env.NODE_ENV === 'production')

// Skip when condition is true
schedule.call(task)
  .daily()
  .skip(() => isMaintenanceMode())
```

## Lifecycle Callbacks

### Before and After

```typescript
schedule.call(task)
  .daily()
  .before(() => console.log('Starting task...'))
  .after(() => console.log('Task completed'))
```

### Success and Failure

```typescript
schedule.call(task)
  .daily()
  .onSuccess(() => {
    console.log('Task succeeded!')
  })
  .onFailure((error) => {
    console.error('Task failed:', error.message)
    notifyAdmin(error)
  })
```

## Scheduler API

### Creating and Managing

```typescript
import { createScheduler } from '@guren/core'

const scheduler = createScheduler({
  timezone: 'UTC',          // Default timezone
  checkInterval: 60000,     // Interval to check for due tasks (ms)
})

// Add tasks
scheduler.addTask(task)
scheduler.schedule(taskDefinition)

// Remove tasks
scheduler.removeTask('task-name')

// Get tasks
const allTasks = scheduler.getTasks()
const task = scheduler.getTask('task-name')
const count = scheduler.count()

// Clear all tasks
scheduler.clear()
```

### Running the Scheduler

```typescript
// Start continuous scheduling
scheduler.start()

// Stop scheduling
scheduler.stop()

// Check if running
const isRunning = scheduler.getIsRunning()

// Manual tick (process due tasks once)
await scheduler.tick()

// Get due tasks without running
const dueTasks = scheduler.getDueTasks()

// Run due tasks manually
await scheduler.runDueTasks()
```

## CLI Commands

### List Scheduled Tasks

View all registered scheduled tasks:

```bash
bunx guren schedule:list
```

**Output:**
```
┌─────────────────┬─────────────────┬──────────────┬─────────────┐
│ Name            │ Expression      │ Next Run     │ Timezone    │
├─────────────────┼─────────────────┼──────────────┼─────────────┤
│ daily-report    │ 0 0 * * *       │ in 6 hours   │ UTC         │
│ cleanup         │ 0 3 * * *       │ in 9 hours   │ UTC         │
│ send-newsletter │ 0 0 * * 0       │ in 3 days    │ America/NY  │
└─────────────────┴─────────────────┴──────────────┴─────────────┘
```

### Run Scheduled Tasks

Manually trigger due tasks:

```bash
# Run all due tasks
bunx guren schedule:run

# Run a specific task by name
bunx guren schedule:run --task daily-report

# Force run (ignore schedule)
bunx guren schedule:run --force
```

## Integration Example

### Application Bootstrap

```typescript
// app/Console/Kernel.ts
import { Schedule, createScheduler } from '@guren/core'
import { SendDailyReportJob } from '../Jobs/SendDailyReportJob'
import { CleanupTempFilesJob } from '../Jobs/CleanupTempFilesJob'

export function scheduleTasksKernel(): Schedule {
  const schedule = new Schedule()

  // Daily report at 9 AM
  schedule.job(SendDailyReportJob, {})
    .dailyAt('09:00')
    .tz('America/New_York')
    .name('daily-report')
    .onFailure((error) => {
      console.error('Daily report failed:', error)
    })

  // Cleanup temp files every 6 hours
  schedule.call(async () => {
    await CleanupTempFilesJob.dispatch({})
  })
    .everySixHours()
    .name('cleanup-temp')
    .preventOverlapping()

  // Database backup at 3 AM
  schedule.command('pg_dump mydb > /backups/db-$(date +%Y%m%d).sql')
    .dailyAt('03:00')
    .name('db-backup')

  return schedule
}

// In your main app file
import { scheduleTasksKernel } from './Console/Kernel'

const schedule = scheduleTasksKernel()
const scheduler = createScheduler({ timezone: 'UTC' })

for (const task of schedule.buildTasks()) {
  scheduler.addTask(task)
}

scheduler.start()
```

## Best Practices

1. **Name your tasks** - Makes debugging and monitoring easier
2. **Use appropriate timezones** - Set timezone explicitly for time-sensitive tasks
3. **Prevent overlapping** - For long-running tasks that shouldn't run concurrently
4. **Add failure handlers** - Get notified when scheduled tasks fail
5. **Use jobs for heavy tasks** - Queue jobs instead of running directly in scheduler
6. **Test locally** - Use `schedule:run --force` to test task execution
