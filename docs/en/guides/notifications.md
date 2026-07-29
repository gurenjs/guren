# Notifications Guide

Guren provides a unified API for sending notifications across multiple channels like email, database, Slack, and more. Notifications are class-based, making them reusable and easy to test.

## Core Concepts

- **Notification** – A class representing a notification with methods for each delivery channel.
- **NotificationManager** – Central hub for registering channels and sending notifications.
- **Notifiable** – Interface for entities that can receive notifications (users, teams, etc.).
- **Channel** – Delivery mechanism (mail, database, Slack, etc.).

## Creating Notifications

### Basic Notification

```ts
import { Notification } from '@guren/core'
import type { Notifiable, NotificationMailMessage } from '@guren/core'

export class OrderShipped extends Notification {
  constructor(
    private readonly order: Order,
    private readonly trackingNumber: string
  ) {
    super()
  }

  // Define delivery channels
  via(notifiable: Notifiable): string[] {
    return ['mail', 'database']
  }

  // Email content
  toMail(notifiable: Notifiable): NotificationMailMessage {
    return {
      subject: `Order #${this.order.id} has shipped!`,
      html: `
        <h1>Your order is on its way!</h1>
        <p>Tracking number: ${this.trackingNumber}</p>
        <a href="/orders/${this.order.id}">View Order</a>
      `,
    }
  }

  // Database record
  toDatabase(notifiable: Notifiable): Record<string, unknown> {
    return {
      orderId: this.order.id,
      trackingNumber: this.trackingNumber,
      message: 'Your order has been shipped',
    }
  }
}
```

### With CLI

```bash
bunx guren make:notification OrderShipped
```

## Sending Notifications

### Setup

```ts
import {
  NotificationManager,
  MailChannel,
  DatabaseChannel,
} from '@guren/core'

const notifications = new NotificationManager()

// Register channels
notifications
  .registerChannel('mail', new MailChannel(mailManager))
  .registerChannel('database', new DatabaseChannel())
```

### Container Integration

The notification subsystem is registered as a singleton via a `ServiceProvider`. You can resolve it from the container:

```ts
// Access via app.container or this.container in providers

const notifications = container.make('notifications') // NotificationManager
await notifications.send(user, new OrderShipped(order, 'ABC123'))
```

### Sending to a User

```ts
// User must implement Notifiable interface
const user: Notifiable = {
  id: 1,
  email: 'user@example.com',
  routeNotificationFor(channel: string): string | null {
    if (channel === 'mail') return this.email
    return null
  },
}

// Send notification
await notifications.send(user, new OrderShipped(order, 'ABC123'))
```

### Sending to Multiple Users

```ts
await notifications.sendToMany(users, new OrderShipped(order, 'ABC123'))
```

### Immediate Sending (Skip Queue)

```ts
// Send immediately even if notification is configured to queue
await notifications.sendNow(user, new OrderShipped(order, 'ABC123'))
```

## Notification Channels

### Mail Channel

```ts
import { MailChannel } from '@guren/core'

const mailChannel = new MailChannel(mailManager, {
  from: 'notifications@example.com',
})

// In notification class
toMail(notifiable: Notifiable): NotificationMailMessage {
  return {
    subject: 'Welcome!',
    html: '<h1>Welcome to our platform!</h1>',
    text: 'Welcome to our platform!',
    from: 'hello@example.com',  // Override default
    replyTo: 'support@example.com',
    cc: ['admin@example.com'],
    attachments: [{
      filename: 'welcome.pdf',
      path: './storage/welcome.pdf',
    }],
  }
}
```

### Database Channel

Store notifications in the database:

```ts
import { DatabaseChannel } from '@guren/core'

const databaseChannel = new DatabaseChannel({
  store: async (notifiable, notification) => {
    await Notification.create({
      id: notification.id,
      type: notification.type,
      notifiableId: notifiable.id,
      notifiableType: 'User',
      data: notification.data,
      readAt: null,
      createdAt: notification.createdAt,
    })
  },
})

// In notification class
toDatabase(notifiable: Notifiable): Record<string, unknown> {
  return {
    title: 'New Comment',
    message: 'Someone commented on your post',
    postId: this.post.id,
    commentId: this.comment.id,
  }
}
```

### Slack Channel

```ts
import { SlackChannel } from '@guren/core'

const slackChannel = new SlackChannel({
  webhookUrl: process.env.SLACK_WEBHOOK_URL,
  channel: '#notifications',  // Default channel
  username: 'Notification Bot',
})

// In notification class
toSlack(notifiable: Notifiable): SlackMessage {
  return {
    text: `Order #${this.order.id} has been shipped!`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Order Shipped* :package:\nTracking: ${this.trackingNumber}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View Order' },
            url: `https://example.com/orders/${this.order.id}`,
          },
        ],
      },
    ],
  }
}
```

### Memory Channel (Testing)

```ts
import { MemoryChannel } from '@guren/core'

const memoryChannel = new MemoryChannel()

// Later, check sent notifications
const sent = memoryChannel.getSentNotifications()
```

## Notifiable Interface

Entities receiving notifications must implement `Notifiable`:

```ts
import type { Notifiable } from '@guren/core'

class User implements Notifiable {
  id: number
  email: string
  slackId?: string
  phone?: string

  routeNotificationFor(channel: string): string | null {
    switch (channel) {
      case 'mail':
        return this.email
      case 'slack':
        return this.slackId ?? null
      case 'sms':
        return this.phone ?? null
      default:
        return null
    }
  }
}
```

### Pinning the Notifiable Type

The database channel persists a `notifiableType` alongside each record, and it
defaults to the constructor name. That name is lost in two places: a bundler can
mangle it, and a notifiable rebuilt from a queued payload is a plain object, so
its constructor name is `Object`.

Declare `notifiableType` to pin it — the mirror of `Notification.type` on the
notification side:

```ts
class User implements Notifiable {
  notifiableType = 'User'

  routeNotificationFor(channel: string): string | null {
    // ...
  }
}
```

The declared type is serialized into the queue payload and restored onto the
notifiable the worker rebuilds, so it survives the round trip.

## Queued Notifications

### Configure Queue

```ts
export class WelcomeNotification extends Notification {
  // Enable queuing
  static shouldQueue = true

  // Specify queue name (optional)
  static queue = 'notifications'

  // Add delay in milliseconds (optional)
  static delay = 5000  // 5 seconds

  via(notifiable: Notifiable): string[] {
    return ['mail']
  }

  toMail(notifiable: Notifiable): NotificationMailMessage {
    return {
      subject: 'Welcome!',
      html: '<h1>Welcome to our app!</h1>',
    }
  }
}
```

### Queue Setup

```ts
import { createQueueManager, MemoryDriver } from '@guren/core'

const queue = createQueueManager({
  default: 'memory',
  drivers: {
    memory: () => new MemoryDriver(),
  },
})

queue.driver()

// Notifications with shouldQueue = true will be queued
await notifications.send(user, new WelcomeNotification())

// Process with worker
// bunx guren queue:work --queue=notifications
```

## Conditional Notifications

### shouldSend Method

```ts
class OrderStatusNotification extends Notification {
  constructor(private readonly order: Order) {
    super()
  }

  // Only send if user has notifications enabled
  async shouldSend(notifiable: Notifiable): Promise<boolean> {
    const user = notifiable as User
    return user.notificationsEnabled && !user.isDeleted
  }

  via(notifiable: Notifiable): string[] {
    const channels = ['database']

    // Add mail only if user opted in
    if ((notifiable as User).emailNotifications) {
      channels.push('mail')
    }

    return channels
  }

  toMail(notifiable: Notifiable): NotificationMailMessage {
    return {
      subject: `Order #${this.order.id} Update`,
      html: `<p>Your order status: ${this.order.status}</p>`,
    }
  }

  toDatabase(notifiable: Notifiable): Record<string, unknown> {
    return {
      orderId: this.order.id,
      status: this.order.status,
    }
  }
}
```

## Custom Channels

Create custom notification channels:

```ts
import type { NotificationChannel, Notifiable } from '@guren/core'
import type { Notification } from '@guren/core'

class SMSChannel implements NotificationChannel {
  readonly name = 'sms'

  constructor(private readonly twilioClient: TwilioClient) {}

  async send(notifiable: Notifiable, notification: Notification): Promise<void> {
    const phone = notifiable.routeNotificationFor('sms')
    if (!phone) return

    // Get SMS content from notification
    const message = (notification as any).toSMS?.(notifiable)
    if (!message) return

    await this.twilioClient.messages.create({
      to: phone,
      from: process.env.TWILIO_FROM,
      body: message.body,
    })
  }
}

// Register the channel
notifications.registerChannel('sms', new SMSChannel(twilioClient))

// Use in notification
class OrderConfirmation extends Notification {
  via(notifiable: Notifiable): string[] {
    return ['mail', 'sms']
  }

  toSMS(notifiable: Notifiable) {
    return {
      body: `Order #${this.order.id} confirmed! Total: $${this.order.total}`,
    }
  }
}
```

## Testing

### Using `container.fake()`

Swap the notification manager in tests:

```ts
// Access via app.container or this.container in providers
import { NotificationManager, MemoryChannel } from '@guren/core'

test('sends order notification', async () => {
  const memoryChannel = new MemoryChannel()
  const fakeNotifications = new NotificationManager({
    channels: { memory: memoryChannel },
  })

  using _ = container.fake('notifications', fakeNotifications)

  // Run code under test
  const sent = memoryChannel.getSentNotifications()
  expect(sent).toHaveLength(1)
})
```

### Manual Testing

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import {
  NotificationManager,
  MemoryChannel,
  Notification,
} from '@guren/core'
import type { Notifiable, NotificationMailMessage } from '@guren/core'

class TestNotification extends Notification {
  via() {
    return ['memory']
  }

  toMail(): NotificationMailMessage {
    return { subject: 'Test', html: '<p>Test</p>' }
  }
}

describe('Notifications', () => {
  let notifications: NotificationManager
  let memoryChannel: MemoryChannel

  beforeEach(() => {
    memoryChannel = new MemoryChannel()
    notifications = new NotificationManager({
      channels: { memory: memoryChannel },
    })
  })

  test('sends notification', async () => {
    const user: Notifiable = {
      id: 1,
      routeNotificationFor: () => 'test@example.com',
    }

    await notifications.send(user, new TestNotification())

    const sent = memoryChannel.getSentNotifications()
    expect(sent).toHaveLength(1)
    expect(sent[0].notification).toBeInstanceOf(TestNotification)
  })

  test('respects shouldSend', async () => {
    class ConditionalNotification extends Notification {
      shouldSend() {
        return false
      }
      via() {
        return ['memory']
      }
    }

    const user: Notifiable = {
      id: 1,
      routeNotificationFor: () => 'test@example.com',
    }

    await notifications.send(user, new ConditionalNotification())

    expect(memoryChannel.getSentNotifications()).toHaveLength(0)
  })

  test('sends to multiple channels', async () => {
    const mailChannel = new MemoryChannel()
    const dbChannel = new MemoryChannel()

    notifications.registerChannel('mail', mailChannel)
    notifications.registerChannel('database', dbChannel)

    class MultiChannelNotification extends Notification {
      via() {
        return ['mail', 'database']
      }
      toMail() {
        return { subject: 'Test', html: '<p>Test</p>' }
      }
      toDatabase() {
        return { message: 'Test' }
      }
    }

    const user: Notifiable = {
      id: 1,
      routeNotificationFor: () => 'test@example.com',
    }

    await notifications.send(user, new MultiChannelNotification())

    expect(mailChannel.getSentNotifications()).toHaveLength(1)
    expect(dbChannel.getSentNotifications()).toHaveLength(1)
  })
})
```

## Best Practices

1. **One notification per event**: Create separate notification classes for different events.

2. **Keep notifications focused**: Each notification should have a clear purpose.

3. **Use queuing for non-critical notifications**: Queue email and Slack notifications to avoid blocking.

4. **Implement shouldSend for conditional logic**: Use `shouldSend()` instead of checking conditions before sending.

5. **Test notification content**: Write tests to verify notification messages are correct.

6. **Handle channel failures gracefully**: Channels should log errors without breaking other channels.

7. **Use typed payloads**: Define interfaces for notification data for type safety.

8. **Store database notifications for in-app notifications**: Use the database channel for notification centers.
