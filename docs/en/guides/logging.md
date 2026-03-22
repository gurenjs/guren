# Logging Guide

Guren provides a flexible logging system with multiple channels, log levels following RFC 5424, and contextual logging support.

## Core Concepts

- **LogManager** – Central hub for managing logging channels.
- **Logger** – Instance for writing log entries with context support.
- **LogChannel** – Destination for log entries (console, file, etc.).
- **LogLevel** – Severity level following RFC 5424 (emergency, alert, critical, error, warning, notice, info, debug).

## Basic Usage

### Quick Start (Facade)

The simplest way to log is through the `LogFacade`, which resolves the `LogManager` from the container lazily:

```ts
import { LogFacade as Log } from '@guren/core'

Log.info('Application started')
Log.error('Something went wrong', { error: 'Connection failed' })
Log.channel('daily').warning('Disk space low')
```

### Direct Instantiation

You can also create a `LogManager` directly:

```ts
import { LogManager } from '@guren/core'

const log = new LogManager({
  default: 'console',
  channels: {
    console: { driver: 'console', level: 'debug' },
  },
})

log.info('Application started')
log.error('Something went wrong', { error: 'Connection failed' })
```

### Log Levels

Guren supports RFC 5424 severity levels (from most to least severe):

```ts
log.emergency('System is unusable')
log.alert('Action must be taken immediately')
log.critical('Critical conditions')
log.error('Error conditions')
log.warning('Warning conditions')  // or log.warn()
log.notice('Normal but significant conditions')
log.info('Informational messages')
log.debug('Debug-level messages')
```

### Logging with Context

```ts
// Add context to individual log entries
log.info('User logged in', { userId: 123, ip: '192.168.1.1' })

// Create a logger with persistent context
const requestLog = log.withContext({ requestId: 'abc-123' })
requestLog.info('Processing request')    // Includes requestId
requestLog.info('Request completed')     // Includes requestId

// Create child loggers
const userLog = requestLog.child({ userId: 456 })
userLog.info('User action')  // Includes requestId and userId
```

## Channels

### Console Channel

Output logs to the console with colors and formatting:

```ts
const log = new LogManager({
  default: 'console',
  channels: {
    console: {
      driver: 'console',
      level: 'debug',          // Minimum level to log
      colors: true,            // Enable ANSI colors
      timestamps: true,        // Include timestamps
      format: 'text',          // 'text' or 'json'
    },
  },
})
```

### File Channel

Write logs to a single file:

```ts
const log = new LogManager({
  default: 'file',
  channels: {
    file: {
      driver: 'file',
      path: './storage/logs/app.log',
      level: 'info',
      format: 'json',  // 'text' or 'json'
    },
  },
})
```

### Daily File Channel

Rotate log files daily with automatic cleanup:

```ts
const log = new LogManager({
  default: 'daily',
  channels: {
    daily: {
      driver: 'daily',
      path: './storage/logs/app.log',
      days: 14,        // Keep logs for 14 days
      level: 'info',
      format: 'json',
    },
  },
})
```

Files are named with date suffix: `app-2024-01-15.log`

### Stack Channel

Combine multiple channels:

```ts
const log = new LogManager({
  default: 'stack',
  channels: {
    console: { driver: 'console', level: 'debug' },
    file: { driver: 'daily', path: './storage/logs/app.log', days: 14 },
    stack: {
      driver: 'stack',
      channels: ['console', 'file'],  // Write to both
    },
  },
})
```

## Using Multiple Channels

### Switch Between Channels

```ts
// Use default channel
log.info('Using default')

// Use specific channel
log.channel('console').debug('Debug info')
log.channel('file').error('Logged to file only')
```

### Ad-hoc Stack

```ts
// Create a temporary stack
log.stack(['console', 'file']).critical('Critical error!')
```

## Configuration

### Full Configuration Example

```ts
import { LogManager } from '@guren/core'

const log = new LogManager({
  default: 'stack',
  channels: {
    // Console for development
    console: {
      driver: 'console',
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      colors: true,
      timestamps: true,
      format: 'text',
    },

    // Daily rotating file for production
    daily: {
      driver: 'daily',
      path: './storage/logs/app.log',
      level: 'info',
      days: 30,
      format: 'json',
    },

    // Error-only log
    errors: {
      driver: 'daily',
      path: './storage/logs/errors.log',
      level: 'error',
      days: 90,
      format: 'json',
    },

    // Stack for default logging
    stack: {
      driver: 'stack',
      channels: ['console', 'daily'],
    },

    // Critical alerts
    critical: {
      driver: 'stack',
      channels: ['console', 'daily', 'errors'],
    },
  },
})
```

## Container Integration

The logging subsystem is registered as a singleton via a `ServiceProvider`. You can resolve it from the container:

```ts
import { container } from '@guren/core'

const log = container.make('log') // LogManager
log.info('Using container-resolved logger')
```

## Global Logger

### Setting Up Global Logger

> [!NOTE]
> In most applications you should prefer the `LogFacade` or `container.make('log')` instead of the global setter. The global functions below are kept for backward compatibility.

```ts
import { setLogManager, getLogManager, LogManager } from '@guren/core'

// In your bootstrap file
const log = new LogManager({
  default: 'stack',
  channels: { /* ... */ },
})

setLogManager(log)

// Anywhere in your application
const log = getLogManager()
log.info('Using global logger')
```

## Custom Channels

### Creating a Custom Channel

```ts
import type { LogChannel, LogEntry } from '@guren/core'

class SlackChannel implements LogChannel {
  constructor(private webhookUrl: string) {}

  async log(entry: LogEntry): Promise<void> {
    if (entry.level !== 'critical' && entry.level !== 'emergency') {
      return // Only send critical/emergency to Slack
    }

    await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `[${entry.level.toUpperCase()}] ${entry.message}`,
        attachments: [{
          fields: Object.entries(entry.context).map(([k, v]) => ({
            title: k,
            value: String(v),
            short: true,
          })),
        }],
      }),
    })
  }
}
```

### Registering Custom Drivers

```ts
const log = new LogManager({
  default: 'stack',
  channels: {
    slack: { driver: 'slack', webhookUrl: process.env.SLACK_WEBHOOK },
    stack: { driver: 'stack', channels: ['console', 'slack'] },
  },
})

log.registerDriver('slack', (config) => {
  return new SlackChannel(config.webhookUrl as string)
})
```

## Request Logging

### Middleware Example

```ts
import { defineMiddleware } from '@guren/core'
import { getLogManager } from '@guren/core'

export const requestLogging = defineMiddleware(async (c, next) => {
  const log = getLogManager()
  const requestId = crypto.randomUUID()
  const requestLog = log.withContext({
    requestId,
    method: c.req.method,
    path: c.req.path,
  })

  const start = Date.now()
  requestLog.info('Request started')

  // Store logger in context for use in handlers
  c.set('log', requestLog)

  try {
    await next()

    requestLog.info('Request completed', {
      status: c.res.status,
      duration: Date.now() - start,
    })
  } catch (error) {
    requestLog.error('Request failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      duration: Date.now() - start,
    })
    throw error
  }
})
```

## Testing

### Using `container.fake()`

Swap the log manager in tests to capture log output:

```ts
import { container } from '@guren/core'
import { LogManager } from '@guren/core'

test('logs error on failure', async () => {
  const fakeLog = new LogManager({
    default: 'memory',
    channels: { memory: { driver: 'memory' } },
  })

  using _ = container.fake('log', fakeLog)

  // Run code under test — all logging via the facade or container
  // is captured by fakeLog
})
```

### Custom Memory Channel

```ts
import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { LogManager, Logger, LOG_LEVEL_PRIORITY } from '@guren/core'
import type { LogChannel, LogEntry } from '@guren/core'

// Create a memory channel for testing
class MemoryChannel implements LogChannel {
  entries: LogEntry[] = []

  log(entry: LogEntry): void {
    this.entries.push(entry)
  }

  clear(): void {
    this.entries = []
  }
}

describe('Logging', () => {
  let memoryChannel: MemoryChannel
  let log: LogManager

  beforeEach(() => {
    memoryChannel = new MemoryChannel()
    log = new LogManager({
      default: 'memory',
      channels: {
        memory: { driver: 'memory' },
      },
    })
    log.registerDriver('memory', () => memoryChannel)
  })

  test('logs at different levels', () => {
    log.info('Info message')
    log.error('Error message')

    expect(memoryChannel.entries).toHaveLength(2)
    expect(memoryChannel.entries[0].level).toBe('info')
    expect(memoryChannel.entries[1].level).toBe('error')
  })

  test('includes context in log entries', () => {
    log.info('User action', { userId: 123 })

    expect(memoryChannel.entries[0].context).toEqual({ userId: 123 })
  })

  test('withContext adds persistent context', () => {
    const requestLog = log.withContext({ requestId: 'abc' })
    requestLog.info('First')
    requestLog.info('Second', { extra: 'data' })

    expect(memoryChannel.entries[0].context).toEqual({ requestId: 'abc' })
    expect(memoryChannel.entries[1].context).toEqual({ requestId: 'abc', extra: 'data' })
  })
})
```

## Log Output Formats

### Text Format

```
[2024-01-15T10:30:00.000Z] INFO      User logged in {"userId":123,"ip":"192.168.1.1"}
[2024-01-15T10:30:01.000Z] ERROR     Database connection failed {"error":"ECONNREFUSED"}
```

### JSON Format

```json
{"timestamp":"2024-01-15T10:30:00.000Z","level":"info","message":"User logged in","userId":123,"ip":"192.168.1.1"}
{"timestamp":"2024-01-15T10:30:01.000Z","level":"error","message":"Database connection failed","error":"ECONNREFUSED"}
```

## Best Practices

1. **Use appropriate log levels**: Don't log everything as error; use debug for development info.

2. **Include context**: Always add relevant context (user ID, request ID, etc.) for debugging.

3. **Use structured logging**: JSON format is easier to parse and search in production.

4. **Rotate log files**: Use the daily driver to prevent disk space issues.

5. **Filter by level in production**: Set console to 'info' or higher in production.

6. **Create contextual loggers**: Use `withContext()` for request-scoped logging.

7. **Don't log sensitive data**: Never log passwords, tokens, or PII.

8. **Close channels on shutdown**: Call `log.close()` to flush pending writes.
