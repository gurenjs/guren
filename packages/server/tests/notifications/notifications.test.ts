import { describe, expect, it, beforeEach, mock } from 'bun:test'
import {
  Notification,
  NotificationManager,
  MailChannel,
  DatabaseChannel,
  SlackChannel,
  MemoryChannel,
  createNotificationManager,
  setNotificationManager,
  getNotificationManager,
  type Notifiable,
  type NotificationMailMessage,
  type SlackMessage,
  type NotificationChannel,
} from '../../src/notifications'

// Test notification classes
class TestNotification extends Notification {
  constructor(public message: string = 'Test') {
    super()
  }

  via(_notifiable: Notifiable): string[] {
    return ['memory']
  }
}

class MultiChannelNotification extends Notification {
  via(_notifiable: Notifiable): string[] {
    return ['mail', 'database', 'slack']
  }

  toMail(_notifiable: Notifiable): NotificationMailMessage {
    return {
      subject: 'Test Subject',
      html: '<p>Test HTML</p>',
      text: 'Test Text',
    }
  }

  toDatabase(_notifiable: Notifiable): Record<string, unknown> {
    return {
      key: 'value',
      timestamp: Date.now(),
    }
  }

  toSlack(_notifiable: Notifiable): SlackMessage {
    return {
      text: 'Test Slack message',
    }
  }
}

class QueuedNotification extends Notification {
  static shouldQueue = true
  static queue = 'notifications'
  static delay = 1000

  via(_notifiable: Notifiable): string[] {
    return ['memory']
  }
}

class ConditionalNotification extends Notification {
  constructor(private shouldSendFlag: boolean) {
    super()
  }

  via(_notifiable: Notifiable): string[] {
    return ['memory']
  }

  shouldSend(_notifiable: Notifiable): boolean {
    return this.shouldSendFlag
  }
}

// Test notifiable
class TestUser implements Notifiable {
  notifications: any[] = []

  constructor(
    public id: number,
    public email: string,
    public slackId?: string
  ) {}

  routeNotificationFor(channel: string): string | null {
    switch (channel) {
      case 'mail':
        return this.email
      case 'slack':
        return this.slackId ?? null
      default:
        return null
    }
  }
}

describe('Notification', () => {
  describe('constructor', () => {
    it('should generate a unique ID', () => {
      const n1 = new TestNotification()
      const n2 = new TestNotification()

      expect(n1.id).toBeDefined()
      expect(n2.id).toBeDefined()
      expect(n1.id).not.toBe(n2.id)
      expect(n1.id).toMatch(/^notif_/)
    })

    it('should set createdAt timestamp', () => {
      const before = new Date()
      const notification = new TestNotification()
      const after = new Date()

      expect(notification.createdAt).toBeInstanceOf(Date)
      expect(notification.createdAt.getTime()).toBeGreaterThanOrEqual(
        before.getTime()
      )
      expect(notification.createdAt.getTime()).toBeLessThanOrEqual(
        after.getTime()
      )
    })
  })

  describe('type', () => {
    it('should return class name as type', () => {
      const notification = new TestNotification()
      expect(notification.type).toBe('TestNotification')
    })
  })

  describe('via', () => {
    it('should return channels array', () => {
      const notification = new TestNotification()
      const user = new TestUser(1, 'test@example.com')

      expect(notification.via(user)).toEqual(['memory'])
    })
  })

  describe('shouldSend', () => {
    it('should return true by default', async () => {
      const notification = new TestNotification()
      const user = new TestUser(1, 'test@example.com')

      expect(await notification.shouldSend(user)).toBe(true)
    })

    it('should respect custom shouldSend logic', async () => {
      const user = new TestUser(1, 'test@example.com')

      const sendNotification = new ConditionalNotification(true)
      expect(await sendNotification.shouldSend(user)).toBe(true)

      const dontSendNotification = new ConditionalNotification(false)
      expect(await dontSendNotification.shouldSend(user)).toBe(false)
    })
  })

  describe('static queue config', () => {
    it('should have default queue config', () => {
      const config = TestNotification.getQueueConfig()
      expect(config.shouldQueue).toBe(false)
      expect(config.queue).toBeUndefined()
      expect(config.delay).toBeUndefined()
    })

    it('should return custom queue config', () => {
      const config = QueuedNotification.getQueueConfig()
      expect(config.shouldQueue).toBe(true)
      expect(config.queue).toBe('notifications')
      expect(config.delay).toBe(1000)
    })
  })
})

describe('NotificationManager', () => {
  let manager: NotificationManager
  let memoryChannel: MemoryChannel

  beforeEach(() => {
    memoryChannel = new MemoryChannel()
    manager = new NotificationManager({
      channels: {
        memory: memoryChannel,
      },
    })
  })

  describe('registerChannel', () => {
    it('should register a channel', () => {
      const customChannel: NotificationChannel = {
        name: 'custom',
        send: async () => {},
      }

      manager.registerChannel('custom', customChannel)
      expect(manager.hasChannel('custom')).toBe(true)
    })
  })

  describe('registerChannelFactory', () => {
    it('should register a channel factory', () => {
      manager.registerChannelFactory('lazy', () => ({
        name: 'lazy',
        send: async () => {},
      }))

      expect(manager.hasChannel('lazy')).toBe(true)
    })
  })

  describe('channel', () => {
    it('should return registered channel', () => {
      const channel = manager.channel('memory')
      expect(channel).toBe(memoryChannel)
    })

    it('should throw for unknown channel', () => {
      expect(() => manager.channel('unknown')).toThrow(
        'Notification channel "unknown" not found'
      )
    })

    it('should create channel from factory', () => {
      let created = false
      manager.registerChannelFactory('lazy', () => {
        created = true
        return { name: 'lazy', send: async () => {} }
      })

      expect(created).toBe(false)
      manager.channel('lazy')
      expect(created).toBe(true)
    })

    it('should cache factory-created channels', () => {
      let createCount = 0
      manager.registerChannelFactory('lazy', () => {
        createCount++
        return { name: 'lazy', send: async () => {} }
      })

      manager.channel('lazy')
      manager.channel('lazy')
      expect(createCount).toBe(1)
    })
  })

  describe('hasChannel', () => {
    it('should return true for registered channels', () => {
      expect(manager.hasChannel('memory')).toBe(true)
    })

    it('should return false for unregistered channels', () => {
      expect(manager.hasChannel('unknown')).toBe(false)
    })
  })

  describe('getChannelNames', () => {
    it('should return all channel names', () => {
      manager.registerChannel('custom', { name: 'custom', send: async () => {} })
      manager.registerChannelFactory('lazy', () => ({
        name: 'lazy',
        send: async () => {},
      }))

      const names = manager.getChannelNames()
      expect(names).toContain('memory')
      expect(names).toContain('custom')
      expect(names).toContain('lazy')
    })
  })

  describe('send', () => {
    it('should send notification immediately when not queued', async () => {
      const user = new TestUser(1, 'test@example.com')
      const notification = new TestNotification()

      await manager.send(user, notification)

      memoryChannel.assertSentTo(user)
      memoryChannel.assertCount(1)
    })

    it('should respect shouldSend', async () => {
      const user = new TestUser(1, 'test@example.com')
      const notification = new ConditionalNotification(false)

      await manager.send(user, notification)

      memoryChannel.assertNothingSent()
    })
  })

  describe('sendNow', () => {
    it('should send notification immediately', async () => {
      const user = new TestUser(1, 'test@example.com')
      const notification = new TestNotification()

      await manager.sendNow(user, notification)

      memoryChannel.assertSentTo(user)
    })

    it('should send through all channels', async () => {
      const mockMailChannel: NotificationChannel = {
        name: 'mail',
        send: mock(() => Promise.resolve()),
      }
      const mockDbChannel: NotificationChannel = {
        name: 'database',
        send: mock(() => Promise.resolve()),
      }
      const mockSlackChannel: NotificationChannel = {
        name: 'slack',
        send: mock(() => Promise.resolve()),
      }

      manager.registerChannel('mail', mockMailChannel)
      manager.registerChannel('database', mockDbChannel)
      manager.registerChannel('slack', mockSlackChannel)

      const user = new TestUser(1, 'test@example.com', '#channel')
      const notification = new MultiChannelNotification()

      await manager.sendNow(user, notification)

      expect(mockMailChannel.send).toHaveBeenCalledTimes(1)
      expect(mockDbChannel.send).toHaveBeenCalledTimes(1)
      expect(mockSlackChannel.send).toHaveBeenCalledTimes(1)
    })
  })

  describe('sendToMany', () => {
    it('should send notification to multiple notifiables', async () => {
      const user1 = new TestUser(1, 'user1@example.com')
      const user2 = new TestUser(2, 'user2@example.com')
      const user3 = new TestUser(3, 'user3@example.com')

      const notification = new TestNotification()

      await manager.sendToMany([user1, user2, user3], notification)

      memoryChannel.assertCount(3)
      memoryChannel.assertSentTo(user1)
      memoryChannel.assertSentTo(user2)
      memoryChannel.assertSentTo(user3)
    })
  })

  describe('sendNowToMany', () => {
    it('should send immediately to multiple notifiables', async () => {
      const user1 = new TestUser(1, 'user1@example.com')
      const user2 = new TestUser(2, 'user2@example.com')

      const notification = new TestNotification()

      await manager.sendNowToMany([user1, user2], notification)

      memoryChannel.assertCount(2)
    })
  })
})

describe('MemoryChannel', () => {
  let channel: MemoryChannel
  let user: TestUser

  beforeEach(() => {
    channel = new MemoryChannel()
    user = new TestUser(1, 'test@example.com')
  })

  describe('send', () => {
    it('should store sent notifications', async () => {
      const notification = new TestNotification()
      await channel.send(user, notification)

      expect(channel.sent).toHaveLength(1)
      expect(channel.sent[0].notifiable).toBe(user)
      expect(channel.sent[0].notification).toBe(notification)
    })

    it('should record timestamp', async () => {
      const notification = new TestNotification()
      const before = new Date()
      await channel.send(user, notification)
      const after = new Date()

      expect(channel.sent[0].timestamp.getTime()).toBeGreaterThanOrEqual(
        before.getTime()
      )
      expect(channel.sent[0].timestamp.getTime()).toBeLessThanOrEqual(
        after.getTime()
      )
    })
  })

  describe('assertSentTo', () => {
    it('should pass when notification was sent', async () => {
      const notification = new TestNotification()
      await channel.send(user, notification)

      expect(() => channel.assertSentTo(user)).not.toThrow()
    })

    it('should throw when notification was not sent', () => {
      expect(() => channel.assertSentTo(user)).toThrow(
        'Expected notification to be sent to notifiable'
      )
    })

    it('should check notification type', async () => {
      const notification = new TestNotification()
      await channel.send(user, notification)

      expect(() =>
        channel.assertSentTo(user, 'TestNotification')
      ).not.toThrow()
      expect(() => channel.assertSentTo(user, 'OtherNotification')).toThrow()
    })
  })

  describe('assertNotSentTo', () => {
    it('should pass when notification was not sent', () => {
      expect(() => channel.assertNotSentTo(user)).not.toThrow()
    })

    it('should throw when notification was sent', async () => {
      const notification = new TestNotification()
      await channel.send(user, notification)

      expect(() => channel.assertNotSentTo(user)).toThrow(
        'Expected notification not to be sent to notifiable'
      )
    })
  })

  describe('assertCount', () => {
    it('should pass when count matches', async () => {
      const notification = new TestNotification()
      await channel.send(user, notification)
      await channel.send(user, notification)

      expect(() => channel.assertCount(2)).not.toThrow()
    })

    it('should throw when count does not match', () => {
      expect(() => channel.assertCount(1)).toThrow(
        'Expected 1 notifications to be sent, but 0 were sent'
      )
    })
  })

  describe('assertSent', () => {
    it('should pass when notification type was sent', async () => {
      await channel.send(user, new TestNotification())

      expect(() => channel.assertSent('TestNotification')).not.toThrow()
    })

    it('should throw when notification type was not sent', () => {
      expect(() => channel.assertSent('TestNotification')).toThrow(
        'Expected notification of type "TestNotification" to be sent'
      )
    })
  })

  describe('assertNotSent', () => {
    it('should pass when notification type was not sent', () => {
      expect(() => channel.assertNotSent('TestNotification')).not.toThrow()
    })

    it('should throw when notification type was sent', async () => {
      await channel.send(user, new TestNotification())

      expect(() => channel.assertNotSent('TestNotification')).toThrow(
        'Expected notification of type "TestNotification" not to be sent'
      )
    })
  })

  describe('assertNothingSent', () => {
    it('should pass when nothing was sent', () => {
      expect(() => channel.assertNothingSent()).not.toThrow()
    })

    it('should throw when something was sent', async () => {
      await channel.send(user, new TestNotification())

      expect(() => channel.assertNothingSent()).toThrow(
        'Expected no notifications to be sent, but 1 were sent'
      )
    })
  })

  describe('getSentTo', () => {
    it('should return notifications sent to notifiable', async () => {
      const user2 = new TestUser(2, 'user2@example.com')

      await channel.send(user, new TestNotification('1'))
      await channel.send(user2, new TestNotification('2'))
      await channel.send(user, new TestNotification('3'))

      const sent = channel.getSentTo(user)
      expect(sent).toHaveLength(2)
    })
  })

  describe('getSentOfType', () => {
    it('should return notifications of type', async () => {
      await channel.send(user, new TestNotification())
      await channel.send(user, new MultiChannelNotification())

      const sent = channel.getSentOfType('TestNotification')
      expect(sent).toHaveLength(1)
    })
  })

  describe('hasSentTo', () => {
    it('should return true when sent', async () => {
      await channel.send(user, new TestNotification())

      expect(channel.hasSentTo(user)).toBe(true)
      expect(channel.hasSentTo(user, 'TestNotification')).toBe(true)
    })

    it('should return false when not sent', () => {
      expect(channel.hasSentTo(user)).toBe(false)
    })
  })

  describe('hasSent', () => {
    it('should return true when type was sent', async () => {
      await channel.send(user, new TestNotification())

      expect(channel.hasSent('TestNotification')).toBe(true)
    })

    it('should return false when type was not sent', () => {
      expect(channel.hasSent('TestNotification')).toBe(false)
    })
  })

  describe('count', () => {
    it('should return count of sent notifications', async () => {
      expect(channel.count()).toBe(0)

      await channel.send(user, new TestNotification())
      expect(channel.count()).toBe(1)

      await channel.send(user, new TestNotification())
      expect(channel.count()).toBe(2)
    })
  })

  describe('first and last', () => {
    it('should return first and last notifications', async () => {
      const n1 = new TestNotification('first')
      const n2 = new TestNotification('last')

      await channel.send(user, n1)
      await channel.send(user, n2)

      expect(channel.first()?.notification).toBe(n1)
      expect(channel.last()?.notification).toBe(n2)
    })

    it('should return undefined when empty', () => {
      expect(channel.first()).toBeUndefined()
      expect(channel.last()).toBeUndefined()
    })
  })

  describe('clear', () => {
    it('should clear all sent notifications', async () => {
      await channel.send(user, new TestNotification())
      await channel.send(user, new TestNotification())

      channel.clear()

      expect(channel.sent).toHaveLength(0)
    })
  })
})

describe('DatabaseChannel', () => {
  let channel: DatabaseChannel
  let user: TestUser

  beforeEach(() => {
    channel = new DatabaseChannel()
    user = new TestUser(1, 'test@example.com')
    user.notifications = []
  })

  describe('send', () => {
    it('should store notification in notifiable.notifications', async () => {
      const notification = new MultiChannelNotification()
      await channel.send(user, notification)

      expect(user.notifications).toHaveLength(1)
      expect(user.notifications[0].type).toBe('MultiChannelNotification')
      expect(user.notifications[0].data).toEqual({
        key: 'value',
        timestamp: expect.any(Number),
      })
    })

    it('should set notification metadata', async () => {
      const notification = new MultiChannelNotification()
      await channel.send(user, notification)

      const stored = user.notifications[0]
      expect(stored.id).toBe(notification.id)
      expect(stored.notifiableId).toBe(1)
      expect(stored.notifiableType).toBe('TestUser')
      expect(stored.readAt).toBeNull()
      expect(stored.createdAt).toBe(notification.createdAt)
    })

    it('should not store if toDatabase returns undefined', async () => {
      const notification = new TestNotification()
      await channel.send(user, notification)

      expect(user.notifications).toHaveLength(0)
    })

    it('should use custom store callback', async () => {
      const stored: any[] = []
      const customChannel = new DatabaseChannel({
        store: async (_notifiable, notification) => {
          stored.push(notification)
        },
      })

      const notification = new MultiChannelNotification()
      await customChannel.send(user, notification)

      expect(stored).toHaveLength(1)
      expect(user.notifications).toHaveLength(0)
    })
  })

  describe('getStored', () => {
    it('should return all stored notifications', async () => {
      const n1 = new MultiChannelNotification()
      const n2 = new MultiChannelNotification()

      await channel.send(user, n1)
      await channel.send(user, n2)

      const stored = channel.getStored()
      expect(stored).toHaveLength(2)
    })
  })

  describe('getStoredFor', () => {
    it('should return notifications for specific notifiable', async () => {
      const user2 = new TestUser(2, 'user2@example.com')
      user2.notifications = []

      await channel.send(user, new MultiChannelNotification())
      await channel.send(user2, new MultiChannelNotification())
      await channel.send(user, new MultiChannelNotification())

      const stored = channel.getStoredFor(user)
      expect(stored).toHaveLength(2)
    })
  })

  describe('clear', () => {
    it('should clear stored notifications', async () => {
      await channel.send(user, new MultiChannelNotification())
      channel.clear()

      expect(channel.getStored()).toHaveLength(0)
    })
  })
})

describe('SlackChannel', () => {
  let fetchMock: ReturnType<typeof mock>

  beforeEach(() => {
    fetchMock = mock(() =>
      Promise.resolve(new Response('ok', { status: 200 }))
    )
    // @ts-ignore
    global.fetch = fetchMock
  })

  describe('send', () => {
    it('should send notification to Slack webhook', async () => {
      const channel = new SlackChannel('https://hooks.slack.com/test')
      const user = new TestUser(1, 'test@example.com')
      const notification = new MultiChannelNotification()

      await channel.send(user, notification)

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledWith('https://hooks.slack.com/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Test Slack message' }),
      })
    })

    it('should use notifiable-specific webhook URL', async () => {
      const channel = new SlackChannel('https://hooks.slack.com/default')
      const user = new TestUser(1, 'test@example.com', 'https://hooks.slack.com/custom')
      const notification = new MultiChannelNotification()

      await channel.send(user, notification)

      expect(fetchMock).toHaveBeenCalledWith(
        'https://hooks.slack.com/custom',
        expect.any(Object)
      )
    })

    it('should not send if toSlack returns undefined', async () => {
      const channel = new SlackChannel('https://hooks.slack.com/test')
      const user = new TestUser(1, 'test@example.com')
      const notification = new TestNotification()

      await channel.send(user, notification)

      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('should include channel options', async () => {
      const channel = new SlackChannel('https://hooks.slack.com/test', {
        username: 'Bot',
        iconEmoji: ':robot:',
      })
      const user = new TestUser(1, 'test@example.com')
      const notification = new MultiChannelNotification()

      await channel.send(user, notification)

      const call = fetchMock.mock.calls[0]
      const body = JSON.parse(call[1].body)
      expect(body.username).toBe('Bot')
      expect(body.icon_emoji).toBe(':robot:')
    })

    it('should throw on webhook failure', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response('error', { status: 500 }))
      )

      const channel = new SlackChannel('https://hooks.slack.com/test')
      const user = new TestUser(1, 'test@example.com')
      const notification = new MultiChannelNotification()

      await expect(channel.send(user, notification)).rejects.toThrow(
        'Slack webhook failed: 500'
      )
    })
  })
})

describe('MailChannel', () => {
  describe('send', () => {
    it('should send notification via mail manager', async () => {
      const sendMock = mock(() => Promise.resolve({ success: true }))
      const mockMailManager = {
        transport: () => ({
          send: sendMock,
        }),
      }

      const channel = new MailChannel(mockMailManager as any)
      const user = new TestUser(1, 'test@example.com')
      const notification = new MultiChannelNotification()

      await channel.send(user, notification)

      expect(sendMock).toHaveBeenCalledTimes(1)
      expect(sendMock).toHaveBeenCalledWith({
        to: [{ email: 'test@example.com' }],
        from: undefined,
        replyTo: undefined,
        cc: undefined,
        bcc: undefined,
        subject: 'Test Subject',
        html: '<p>Test HTML</p>',
        text: 'Test Text',
        attachments: undefined,
      })
    })

    it('should not send if no email route', async () => {
      const sendMock = mock(() => Promise.resolve({ success: true }))
      const mockMailManager = {
        transport: () => ({
          send: sendMock,
        }),
      }

      const channel = new MailChannel(mockMailManager as any)
      const user: Notifiable = {
        routeNotificationFor: () => null,
      }
      const notification = new MultiChannelNotification()

      await channel.send(user, notification)

      expect(sendMock).not.toHaveBeenCalled()
    })

    it('should not send if toMail returns undefined', async () => {
      const sendMock = mock(() => Promise.resolve({ success: true }))
      const mockMailManager = {
        transport: () => ({
          send: sendMock,
        }),
      }

      const channel = new MailChannel(mockMailManager as any)
      const user = new TestUser(1, 'test@example.com')
      const notification = new TestNotification()

      await channel.send(user, notification)

      expect(sendMock).not.toHaveBeenCalled()
    })

    it('should use channel options', async () => {
      const sendMock = mock(() => Promise.resolve({ success: true }))
      const transportMock = mock(() => ({ send: sendMock }))
      const mockMailManager = {
        transport: transportMock,
      }

      const channel = new MailChannel(mockMailManager as any, {
        from: 'noreply@example.com',
        transport: 'custom',
      })
      const user = new TestUser(1, 'test@example.com')
      const notification = new MultiChannelNotification()

      await channel.send(user, notification)

      expect(transportMock).toHaveBeenCalledWith('custom')
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          from: { email: 'noreply@example.com' },
        })
      )
    })
  })
})

describe('Global notification manager', () => {
  it('should set and get global manager', () => {
    const manager = createNotificationManager()
    setNotificationManager(manager)

    expect(getNotificationManager()).toBe(manager)
  })
})

describe('createNotificationManager', () => {
  it('should create manager with options', () => {
    const memoryChannel = new MemoryChannel()
    const manager = createNotificationManager({
      channels: {
        memory: memoryChannel,
      },
    })

    expect(manager.hasChannel('memory')).toBe(true)
    expect(manager.channel('memory')).toBe(memoryChannel)
  })
})
