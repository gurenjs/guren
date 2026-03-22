# Broadcasting Guide

Guren provides a broadcasting system for real-time event broadcasting to connected clients. This is useful for building features like live notifications, chat applications, and real-time dashboards.

## Core Concepts

- **BroadcastManager** – Central hub for managing channels, drivers, and SSE clients.
- **Channel** – A named conduit for broadcasting events. Channels can be public, private, or presence.
- **BroadcastDriver** – Backend for event distribution (Memory or Redis).
- **SSE (Server-Sent Events)** – Built-in support for pushing events to browser clients.
- **WebSocket Clients** – Built-in lifecycle helpers for registering socket clients and subscribing them to channels.

## Channel Types

- **Public Channels** – Anyone can subscribe.
- **Private Channels** – Require user authentication to subscribe.
- **Presence Channels** – Track who is subscribed (e.g., for "who's online" features).

## Basic Usage

### Setup

```ts
import { BroadcastManager } from '@guren/core'

const broadcast = new BroadcastManager({
  default: 'memory',
  drivers: {
    memory: () => new MemoryDriver(),
  },
})

// Broadcast an event
await broadcast.broadcast('notifications', 'NewMessage', {
  content: 'Hello world!',
})
```

### Container Integration

The broadcasting subsystem is registered as a singleton via a `ServiceProvider`. You can resolve it from the container:

```ts
import { container } from '@guren/core'

const broadcast = container.make('broadcast') // BroadcastManager
await broadcast.broadcast('notifications', 'NewMessage', { content: 'Hello!' })
```

### Using Channel Helpers

```ts
// Public channel
await broadcast.toChannel('notifications').broadcast('NewMessage', data)

// Private channel (auto-prefixed with 'private-')
await broadcast.toPrivate('orders.123').broadcast('OrderUpdated', {
  status: 'shipped',
})

// Presence channel (auto-prefixed with 'presence-')
await broadcast.toPresence('chat.general').broadcast('UserJoined', {
  user: 'John',
})
```

### Subscribing to Channels

```ts
const channel = broadcast.toChannel('notifications')

// Subscribe to events
const unsubscribe = channel.subscribe((event, data) => {
  console.log(`Event: ${event}`, data)
})

// Later, unsubscribe
unsubscribe()
```

## Channel Authorization

### Public Channels

```ts
broadcast.channel('notifications', () => true)
broadcast.channel('public.*', () => true) // Wildcard pattern
```

### Private Channels

Private channels require authentication:

```ts
broadcast.privateChannel('orders.{orderId}', async (channel, user) => {
  // Extract orderId from channel name
  const orderId = channel.replace('private-orders.', '')

  // Check if user owns this order
  const order = await Order.find(orderId)
  return order?.userId === user.id
})

// User-specific channels
broadcast.privateChannel('user.{userId}', (channel, user) => {
  const userId = channel.replace('private-user.', '')
  return String(user.id) === userId
})
```

### Presence Channels

Presence channels return member info when authorized:

```ts
broadcast.presenceChannel('chat.{roomId}', async (channel, user) => {
  if (!user) return null // Not authorized

  // Return presence member info
  return {
    id: user.id,
    info: {
      name: user.name,
      avatar: user.avatar,
    },
  }
})
```

### Pattern Matching

Channel patterns support:
- `{param}` – Match any non-dot segment
- `*` – Match any single segment
- `**` – Match multiple segments

```ts
broadcast.channel('posts.*', () => true)           // posts.123, posts.456
broadcast.channel('users.{id}.posts', authorizer)  // users.1.posts
broadcast.channel('admin.**', isAdmin)             // admin.users, admin.settings.email
```

## Server-Sent Events (SSE)

### SSE Endpoint

```ts
import { Router } from '@guren/core'

export function registerBroadcastRoutes(router: Router): void {
  router.get('/broadcasting/events', broadcast.sseMiddleware({
    pingInterval: 30000,
    retry: 3000,
  }))

  router.post('/broadcasting/auth', broadcast.authMiddleware({
    getUser: (ctx) => ctx.get('user'),
  }))
}
```

## WebSocket Foundation

Guren now includes WebSocket client lifecycle helpers on `BroadcastManager`.  
You can register a socket client, subscribe it to channels, and reuse the same broadcast events used by SSE.

```ts
const clientId = broadcast.registerWebSocketClient({
  send: (event, data) => socket.send(JSON.stringify({ event, data })),
  close: () => socket.close(),
})

broadcast.subscribeWebSocketClient(clientId, 'notifications')

// Later
broadcast.unsubscribeWebSocketClient(clientId, 'notifications')
broadcast.removeWebSocketClient(clientId)
```

These APIs provide the server-side foundation so a Bun WebSocket upgrade route can plug into the existing channel/driver system.

### Typed channel codegen (Wave 3)

`guren codegen` now generates `.guren/channels.gen.ts` from your server-side broadcast usage.

```ts
// app/Providers/BroadcastProvider.ts
broadcast.channel('announcements', () => true)
broadcast.privateChannel('posts.{id}', () => true)
broadcast.broadcast('announcements', 'NewPost', { id: 1 })
```

Generated artifacts include:

- `ChannelName` – channel name union with pattern-aware template literal types.
- `ChannelEvents` – channel-to-event map with inferred payload types for literal/object/array broadcast payloads.
- `channelEventManifest` – runtime manifest for discovered channels/events.

```ts
import type { ChannelEvents } from '../.guren/channels.gen'
import { createUseChannel } from '@guren/inertia-client'

const useChannel = createUseChannel<ChannelEvents>()
const feed = useChannel('announcements')
const off = feed.on('NewPost', (payload) => {
  console.log(payload)
})
```

This gives you typed channel/event names and inferred payload shapes in the frontend.

### End-to-end typed realtime flow (Wave 7)

Use the generated `ChannelEvents` on the server too, so emit-side payloads are checked at compile time.

```ts
import type { ChannelEvents } from '../.guren/channels.gen'
import { createTypedBroadcaster } from '@guren/server'

const typed = createTypedBroadcaster<ChannelEvents>(broadcast)

await typed.broadcast('announcements', 'NewPost', { id: 1 }) // typed payload
await typed.toChannel('announcements').broadcast('NewPost', { id: 2 })
```

### Client-Side Integration

```ts
// Connect to SSE
const eventSource = new EventSource('/broadcasting/events')

eventSource.onopen = () => {
  console.log('Connected')
}

eventSource.onerror = (error) => {
  console.error('Connection error', error)
}

// Listen for events
eventSource.addEventListener('NewMessage', (e) => {
  const data = JSON.parse(e.data)
  console.log('New message:', data)
})

// Listen for ping
eventSource.addEventListener('ping', () => {
  console.log('Keepalive ping')
})
```

### Authorizing Channels (Client)

```ts
async function subscribeToChannel(channel: string) {
  // Authorize the channel
  const response = await fetch('/broadcasting/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel }),
    credentials: 'include',
  })

  const result = await response.json()

  if (result[channel].authorized) {
    // Subscribe to channel events
    eventSource.addEventListener(channel, (e) => {
      const data = JSON.parse(e.data)
      handleChannelEvent(channel, data)
    })
  }
}
```

## Configuration

### Redis Driver

For production and multi-server support:

```ts
import { BroadcastManager, RedisDriver } from '@guren/core'
import { createRedisClient } from '@guren/core'

const redis = createRedisClient({ url: process.env.REDIS_URL })

const broadcast = new BroadcastManager({
  default: 'redis',
  drivers: {
    redis: () => new RedisDriver(redis),
    memory: () => new MemoryDriver(), // Fallback for testing
  },
})
```

### Multiple Drivers

```ts
const broadcast = new BroadcastManager({
  default: 'redis',
  drivers: {
    redis: () => new RedisDriver(redis),
    memory: () => new MemoryDriver(),
  },
})

// Use specific driver
const driver = broadcast.driver('memory')
await driver.publish('test-channel', 'TestEvent', data)
```

## Broadcasting from Events

Integrate broadcasting with the event system:

```ts
import { Event } from '@guren/core'

export class OrderShipped extends Event {
  constructor(
    public readonly orderId: string,
    public readonly trackingNumber: string
  ) {
    super()
  }

  // Implement BroadcastableEvent interface
  broadcastOn(): string[] {
    return [`private-orders.${this.orderId}`]
  }

  broadcastAs(): string {
    return 'OrderShipped'
  }

  broadcastWith(): Record<string, unknown> {
    return {
      orderId: this.orderId,
      trackingNumber: this.trackingNumber,
    }
  }
}

// Usage
const event = new OrderShipped('123', 'ABC456')

for (const channel of event.broadcastOn()) {
  await broadcast.broadcast(
    channel,
    event.broadcastAs?.() ?? event.eventName,
    event.broadcastWith?.() ?? {}
  )
}
```

## Presence Channel Members

Track who's in a presence channel:

```ts
import { PresenceChannel } from '@guren/core'

const channel = broadcast.toPresence('chat.general')

// Get current members (requires PresenceBroadcastDriver)
const driver = broadcast.driver() as PresenceBroadcastDriver
const members = driver.getMembers('presence-chat.general')

// Broadcast member joined
await channel.broadcast('MemberJoined', {
  member: { id: user.id, name: user.name },
})

// Broadcast member left
await channel.broadcast('MemberLeft', {
  memberId: user.id,
})
```

## Testing

### Using `container.fake()`

Swap the broadcast manager in tests:

```ts
import { container } from '@guren/core'
import { BroadcastManager, MemoryDriver } from '@guren/core'

test('broadcasts order update', async () => {
  const fakeBroadcast = new BroadcastManager({
    default: 'memory',
    drivers: { memory: () => new MemoryDriver() },
  })

  using _ = container.fake('broadcast', fakeBroadcast)

  // Code under test that broadcasts events will use fakeBroadcast
})
```

### Manual Testing

```ts
import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { BroadcastManager, MemoryDriver } from '@guren/core'

describe('Broadcasting', () => {
  let broadcast: BroadcastManager

  beforeEach(() => {
    broadcast = new BroadcastManager({
      default: 'memory',
      drivers: {
        memory: () => new MemoryDriver(),
      },
    })
  })

  test('broadcasts to channel', async () => {
    const received: unknown[] = []

    broadcast.driver().subscribe('test', (event) => {
      received.push(event)
    })

    await broadcast.broadcast('test', 'TestEvent', { value: 1 })

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      channel: 'test',
      event: 'TestEvent',
      data: { value: 1 },
    })
  })

  test('authorizes private channel', async () => {
    broadcast.privateChannel('orders.{orderId}', (channel, user) => {
      return user?.id === '123'
    })

    const result = await broadcast.authorize('private-orders.456', { id: '123' })
    expect(result).toBe(true)

    const denied = await broadcast.authorize('private-orders.456', { id: '999' })
    expect(denied).toBe(false)
  })

  test('presence channel returns member info', async () => {
    broadcast.presenceChannel('chat.{roomId}', (channel, user) => {
      if (!user) return null
      return { id: user.id, info: { name: user.name } }
    })

    const result = await broadcast.authorize('presence-chat.1', {
      id: '123',
      name: 'John',
    })

    expect(result).toMatchObject({
      id: '123',
      info: { name: 'John' },
    })
  })
})
```

## Best Practices

1. **Use Redis in production**: Memory driver doesn't work across multiple servers.

2. **Authorize sensitive channels**: Always protect private and presence channels with proper authorization.

3. **Keep payloads small**: Broadcast only essential data to reduce bandwidth.

4. **Handle disconnections**: Implement reconnection logic on the client side.

5. **Use presence channels for real-time features**: Track online users, typing indicators, etc.

6. **Consider message ordering**: Events may arrive out of order; include timestamps if order matters.

7. **Clean up subscriptions**: Always unsubscribe when components unmount or users leave.

8. **Test authorization logic**: Write tests for channel authorizers to prevent security issues.
