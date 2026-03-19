# Events Guide

Guren provides a simple yet powerful event system for decoupling components in your application. Events allow you to broadcast occurrences in your application that other parts can listen and react to.

## Core Concepts

- **Event** – A class representing something that happened in your application. Events carry data about the occurrence.
- **EventManager** – Central hub for registering listeners and emitting events.
- **Listener** – A function or class that reacts to an event when it's emitted.

## Creating Events

### Basic Event

Create custom events by extending the `Event` base class:

```ts
import { Event } from '@guren/core'

export class UserRegistered extends Event {
  constructor(
    public readonly userId: string,
    public readonly email: string
  ) {
    super()
  }
}
```

### With CLI

Generate event classes using the CLI:

```bash
bunx guren make:event UserRegistered
```

This creates `app/Events/UserRegistered.ts`:

```ts
import { Event } from '@guren/core'

export class UserRegistered extends Event {
  constructor() {
    super()
  }
}
```

### Event Properties

All events have:

- `timestamp` – When the event was created (automatically set)
- `eventName` – The event identifier (class name by default)

```ts
class OrderPlaced extends Event {
  // Custom event name (optional)
  static get eventName(): string {
    return 'orders.placed'
  }

  constructor(
    public readonly orderId: string,
    public readonly total: number
  ) {
    super()
  }
}
```

## Registering Listeners

### Basic Usage

```ts
import { EventManager } from '@guren/core'
import { UserRegistered } from '@/app/Events/UserRegistered'

const events = new EventManager()

// Register a listener
events.on(UserRegistered, async (event) => {
  console.log(`User ${event.email} registered at ${event.timestamp}`)
})

// Emit the event
await events.emit(new UserRegistered('123', 'user@example.com'))
```

### One-Time Listeners

```ts
// Listener is automatically removed after first invocation
events.once(ApplicationStarted, (event) => {
  console.log(`App started on port ${event.port}`)
})
```

### Listener Priority

Higher priority listeners execute first:

```ts
// Runs second (default priority: 0)
events.on(UserRegistered, (e) => console.log('Second'))

// Runs first (higher priority)
events.on(UserRegistered, (e) => console.log('First'), { priority: 10 })

// Runs third (lower priority)
events.on(UserRegistered, (e) => console.log('Third'), { priority: -10 })
```

### Unsubscribing

```ts
// Using the subscription handle
const subscription = events.on(UserRegistered, handler)
subscription.unsubscribe()

// Or directly
events.off(UserRegistered, handler)

// Remove all listeners for an event
events.off(UserRegistered)
```

## Listener Classes

For complex listeners, use class-based listeners:

```bash
bunx guren make:listener SendWelcomeEmail
```

```ts
// app/Listeners/SendWelcomeEmail.ts
import { Listener } from '@guren/core'
import { UserRegistered } from '@/app/Events/UserRegistered'
import { mail } from '@guren/core'

export class SendWelcomeEmail extends Listener<UserRegistered> {
  // The event this listener handles
  static event = UserRegistered

  // Optional: Queue the listener execution
  static shouldQueue = true
  static queue = 'emails'

  // Optional: Listener priority
  static priority = 10

  async handle(event: UserRegistered): Promise<void> {
    await mail(mailManager)
      .to(event.email)
      .subject('Welcome!')
      .text('Thanks for registering!')
      .send()
  }

  // Optional: Conditionally handle events
  shouldHandle(event: UserRegistered): boolean {
    // Only send to non-internal emails
    return !event.email.endsWith('@internal.example.com')
  }

  // Optional: Handle failures
  async failed(event: UserRegistered, error: Error): Promise<void> {
    console.error(`Failed to send welcome email to ${event.email}:`, error)
  }
}
```

### Registering Class Listeners

```ts
import { SendWelcomeEmail } from '@/app/Listeners/SendWelcomeEmail'

// Register the listener class
const listenerClass = SendWelcomeEmail
const instance = new listenerClass()

events.on(
  listenerClass.event,
  async (event) => {
    if (instance.shouldHandle?.(event) ?? true) {
      try {
        await instance.handle(event)
      } catch (error) {
        await instance.failed?.(event, error as Error)
      }
    }
  },
  {
    priority: listenerClass.priority,
    queue: listenerClass.shouldQueue ? listenerClass.queue : undefined,
  }
)
```

## Emitting Events

### Sequential Execution

Listeners execute in priority order, one after another:

```ts
// Listeners run sequentially
await events.emit(new UserRegistered('123', 'user@example.com'))
```

### Parallel Execution

For faster execution when order doesn't matter:

```ts
// Listeners run concurrently
await events.emitParallel(new UserRegistered('123', 'user@example.com'))
```

## Built-in Events

Guren provides several built-in events:

### HTTP Events

```ts
import { RequestReceived, RequestFinished } from '@guren/core'

// When a request is received
events.on(RequestReceived, (event) => {
  console.log(`${event.method} ${event.path}`)
})

// When a request is completed
events.on(RequestFinished, (event) => {
  console.log(`${event.method} ${event.path} - ${event.status} (${event.durationMs}ms)`)
})
```

### Authentication Events

```ts
import { UserAuthenticated, UserLoggedOut } from '@guren/core'

events.on(UserAuthenticated, (event) => {
  console.log(`User ${event.userId} logged in via ${event.guard}`)
})

events.on(UserLoggedOut, (event) => {
  console.log(`User ${event.userId} logged out`)
})
```

### Queue Events

```ts
import { JobProcessed, JobFailed } from '@guren/core'

events.on(JobProcessed, (event) => {
  console.log(`Job ${event.jobName} processed in ${event.durationMs}ms`)
})

events.on(JobFailed, (event) => {
  console.error(`Job ${event.jobName} failed:`, event.error.message)
})
```

### Application Events

```ts
import { ApplicationStarted, ApplicationShutdown } from '@guren/core'

events.on(ApplicationStarted, (event) => {
  console.log(`Server running at ${event.host}:${event.port}`)
})

events.on(ApplicationShutdown, (event) => {
  console.log(`Shutting down: ${event.reason}`)
})
```

## Queued Listeners

Dispatch listeners to a queue for async processing:

```ts
// Configure queue integration
import { setQueueDriver, MemoryDriver } from '@guren/core'
setQueueDriver(new MemoryDriver())

// Register a queued listener
events.on(
  UserRegistered,
  async (event) => {
    // This runs in a queue worker
    await sendWelcomeEmail(event)
  },
  { queue: 'emails' }
)
```

## Event Manager Utilities

```ts
const events = new EventManager()

// Check if event has listeners
if (events.hasListeners(UserRegistered)) {
  await events.emit(new UserRegistered(...))
}

// Get listener count
const count = events.listenerCount(UserRegistered)

// Get all event names with listeners
const eventNames = events.eventNames()

// Get all listeners for an event
const listeners = events.getListeners(UserRegistered)

// Remove all listeners
events.removeAllListeners()
```

## Testing

```ts
import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { EventManager } from '@guren/core'
import { UserRegistered } from '@/app/Events/UserRegistered'

describe('Events', () => {
  let events: EventManager

  beforeEach(() => {
    events = new EventManager()
  })

  test('listener is called when event is emitted', async () => {
    const listener = mock(() => {})

    events.on(UserRegistered, listener)
    await events.emit(new UserRegistered('123', 'test@example.com'))

    expect(listener).toHaveBeenCalledTimes(1)
  })

  test('once listener is removed after first call', async () => {
    const listener = mock(() => {})

    events.once(UserRegistered, listener)
    await events.emit(new UserRegistered('123', 'a@example.com'))
    await events.emit(new UserRegistered('456', 'b@example.com'))

    expect(listener).toHaveBeenCalledTimes(1)
  })

  test('listeners execute in priority order', async () => {
    const order: string[] = []

    events.on(UserRegistered, () => order.push('low'), { priority: -10 })
    events.on(UserRegistered, () => order.push('default'))
    events.on(UserRegistered, () => order.push('high'), { priority: 10 })

    await events.emit(new UserRegistered('123', 'test@example.com'))

    expect(order).toEqual(['high', 'default', 'low'])
  })

  test('event data is passed to listener', async () => {
    let receivedEvent: UserRegistered | null = null

    events.on(UserRegistered, (event) => {
      receivedEvent = event
    })

    await events.emit(new UserRegistered('123', 'test@example.com'))

    expect(receivedEvent?.userId).toBe('123')
    expect(receivedEvent?.email).toBe('test@example.com')
  })
})
```

## Best Practices

1. **Name events after what happened**: Use past tense (`UserRegistered`, `OrderPlaced`, `PaymentFailed`).

2. **Keep events immutable**: Use `readonly` properties and don't mutate event data in listeners.

3. **One event per occurrence**: Each event should represent a single, specific thing that happened.

4. **Keep listeners focused**: Each listener should do one thing. Use multiple listeners for multiple side effects.

5. **Use queued listeners for slow operations**: Don't block the main flow with email sending, API calls, etc.

6. **Handle listener errors**: Wrap listener logic in try-catch or use the `failed()` method in class listeners.

7. **Use priority sparingly**: Most listeners should use the default priority. Only adjust when order truly matters.

8. **Consider parallel emission**: Use `emitParallel()` when listeners are independent and don't need ordering.
