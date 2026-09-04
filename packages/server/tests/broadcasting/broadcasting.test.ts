import { describe, expect, it, beforeEach } from 'bun:test'
import {
  BroadcastManager,
  createBroadcastManager,
  setBroadcastManager,
  getBroadcastManager,
  createTypedBroadcaster,
  Channel,
  PrivateChannel,
  PresenceChannel,
  MemoryDriver,
  type BroadcastEvent,
} from '../../src/broadcasting'

describe('MemoryDriver', () => {
  let driver: MemoryDriver

  beforeEach(() => {
    driver = new MemoryDriver()
  })

  describe('publish', () => {
    it('should publish events to channel', async () => {
      const received: BroadcastEvent[] = []
      driver.subscribe('test', (e) => received.push(e))

      await driver.publish('test', 'TestEvent', { foo: 'bar' })

      expect(received).toHaveLength(1)
      expect(received[0].channel).toBe('test')
      expect(received[0].event).toBe('TestEvent')
      expect(received[0].data).toEqual({ foo: 'bar' })
    })

    it('should store published events', async () => {
      await driver.publish('ch1', 'Event1', { a: 1 })
      await driver.publish('ch2', 'Event2', { b: 2 })

      const events = driver.getPublishedEvents()
      expect(events).toHaveLength(2)
    })

    it('should set timestamp on events', async () => {
      const before = new Date()
      await driver.publish('test', 'Event', {})
      const after = new Date()

      const events = driver.getPublishedEvents()
      expect(events[0].timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(events[0].timestamp.getTime()).toBeLessThanOrEqual(after.getTime())
    })
  })

  describe('subscribe', () => {
    it('should subscribe to channel events', async () => {
      const received: BroadcastEvent[] = []
      driver.subscribe('test', (e) => received.push(e))

      await driver.publish('test', 'Event', {})

      expect(received).toHaveLength(1)
    })

    it('should support multiple subscribers', async () => {
      const received1: BroadcastEvent[] = []
      const received2: BroadcastEvent[] = []

      driver.subscribe('test', (e) => received1.push(e))
      driver.subscribe('test', (e) => received2.push(e))

      await driver.publish('test', 'Event', {})

      expect(received1).toHaveLength(1)
      expect(received2).toHaveLength(1)
    })

    it('should return unsubscribe function', async () => {
      const received: BroadcastEvent[] = []
      const unsubscribe = driver.subscribe('test', (e) => received.push(e))

      await driver.publish('test', 'Event1', {})
      unsubscribe()
      await driver.publish('test', 'Event2', {})

      expect(received).toHaveLength(1)
    })

    it('should not receive events from other channels', async () => {
      const received: BroadcastEvent[] = []
      driver.subscribe('channel1', (e) => received.push(e))

      await driver.publish('channel2', 'Event', {})

      expect(received).toHaveLength(0)
    })
  })

  describe('unsubscribe', () => {
    it('should remove subscriber', async () => {
      const received: BroadcastEvent[] = []
      const callback = (e: BroadcastEvent) => received.push(e)

      driver.subscribe('test', callback)
      await driver.publish('test', 'Event1', {})

      driver.unsubscribe('test', callback)
      await driver.publish('test', 'Event2', {})

      expect(received).toHaveLength(1)
    })
  })

  describe('presence', () => {
    it('should add members', () => {
      driver.addMember('room', { id: 1, info: { name: 'Alice' } })
      driver.addMember('room', { id: 2, info: { name: 'Bob' } })

      const members = driver.getMembers('room')
      expect(members).toHaveLength(2)
    })

    it('should remove members', () => {
      driver.addMember('room', { id: 1 })
      driver.addMember('room', { id: 2 })

      driver.removeMember('room', 1)

      const members = driver.getMembers('room')
      expect(members).toHaveLength(1)
      expect(members[0].id).toBe(2)
    })

    it('should return empty array for unknown channel', () => {
      expect(driver.getMembers('unknown')).toEqual([])
    })

    it('should update existing member', () => {
      driver.addMember('room', { id: 1, info: { name: 'Alice' } })
      driver.addMember('room', { id: 1, info: { name: 'Alice Updated' } })

      const members = driver.getMembers('room')
      expect(members).toHaveLength(1)
      expect(members[0].info?.name).toBe('Alice Updated')
    })
  })

  describe('hasSubscribers', () => {
    it('should return true when channel has subscribers', () => {
      driver.subscribe('test', () => {})
      expect(driver.hasSubscribers('test')).toBe(true)
    })

    it('should return false when channel has no subscribers', () => {
      expect(driver.hasSubscribers('test')).toBe(false)
    })
  })

  describe('getSubscriberCount', () => {
    it('should return subscriber count', () => {
      driver.subscribe('test', () => {})
      driver.subscribe('test', () => {})

      expect(driver.getSubscriberCount('test')).toBe(2)
    })

    it('should return 0 for unknown channel', () => {
      expect(driver.getSubscriberCount('unknown')).toBe(0)
    })
  })

  describe('getChannels', () => {
    it('should return channels with subscribers', () => {
      driver.subscribe('ch1', () => {})
      driver.subscribe('ch2', () => {})

      const channels = driver.getChannels()
      expect(channels).toContain('ch1')
      expect(channels).toContain('ch2')
    })
  })

  describe('getPresenceChannels', () => {
    it('should return channels with presence members', () => {
      driver.addMember('room1', { id: 1 })
      driver.addMember('room2', { id: 2 })

      const channels = driver.getPresenceChannels()
      expect(channels).toContain('room1')
      expect(channels).toContain('room2')
    })
  })

  describe('getPublishedEventsFor', () => {
    it('should return events for specific channel', async () => {
      await driver.publish('ch1', 'Event1', {})
      await driver.publish('ch2', 'Event2', {})
      await driver.publish('ch1', 'Event3', {})

      const events = driver.getPublishedEventsFor('ch1')
      expect(events).toHaveLength(2)
    })
  })

  describe('clear', () => {
    it('should clear all data', async () => {
      driver.subscribe('test', () => {})
      driver.addMember('room', { id: 1 })
      await driver.publish('test', 'Event', {})

      driver.clear()

      expect(driver.hasSubscribers('test')).toBe(false)
      expect(driver.getMembers('room')).toHaveLength(0)
      expect(driver.getPublishedEvents()).toHaveLength(0)
    })
  })

  describe('clearPublishedEvents', () => {
    it('should clear only published events', async () => {
      driver.subscribe('test', () => {})
      await driver.publish('test', 'Event', {})

      driver.clearPublishedEvents()

      expect(driver.hasSubscribers('test')).toBe(true)
      expect(driver.getPublishedEvents()).toHaveLength(0)
    })
  })
})

describe('Channel', () => {
  let driver: MemoryDriver

  beforeEach(() => {
    driver = new MemoryDriver()
  })

  describe('constructor', () => {
    it('should create channel with name', () => {
      const channel = new Channel('test', driver)
      expect(channel.name).toBe('test')
    })
  })

  describe('broadcast', () => {
    it('should publish event to driver', async () => {
      const channel = new Channel('notifications', driver)
      await channel.broadcast('NewMessage', { content: 'Hello' })

      const events = driver.getPublishedEvents()
      expect(events).toHaveLength(1)
      expect(events[0].channel).toBe('notifications')
      expect(events[0].event).toBe('NewMessage')
    })
  })

  describe('subscribe', () => {
    it('should subscribe to channel events', async () => {
      const channel = new Channel('notifications', driver)
      const received: Array<{ event: string; data: unknown }> = []

      channel.subscribe((event, data) => received.push({ event, data }))
      await channel.broadcast('NewMessage', { content: 'Hello' })

      expect(received).toHaveLength(1)
      expect(received[0].event).toBe('NewMessage')
    })

    it('should return unsubscribe function', async () => {
      const channel = new Channel('notifications', driver)
      const received: Array<{ event: string; data: unknown }> = []

      const unsubscribe = channel.subscribe((event, data) =>
        received.push({ event, data })
      )

      await channel.broadcast('Event1', {})
      unsubscribe()
      await channel.broadcast('Event2', {})

      expect(received).toHaveLength(1)
    })
  })

  describe('getChannelName', () => {
    it('should return channel name', () => {
      const channel = new Channel('test', driver)
      expect(channel.getChannelName()).toBe('test')
    })
  })
})

describe('PrivateChannel', () => {
  let driver: MemoryDriver

  beforeEach(() => {
    driver = new MemoryDriver()
  })

  describe('constructor', () => {
    it('should add private prefix', () => {
      const channel = new PrivateChannel('orders.123', driver)
      expect(channel.name).toBe('private-orders.123')
    })

    it('should not double prefix', () => {
      const channel = new PrivateChannel('private-orders.123', driver)
      expect(channel.name).toBe('private-orders.123')
    })
  })

  describe('getBaseName', () => {
    it('should return name without prefix', () => {
      const channel = new PrivateChannel('orders.123', driver)
      expect(channel.getBaseName()).toBe('orders.123')
    })
  })

  describe('isPrivateChannel', () => {
    it('should return true for private channels', () => {
      expect(PrivateChannel.isPrivateChannel('private-orders')).toBe(true)
    })

    it('should return false for non-private channels', () => {
      expect(PrivateChannel.isPrivateChannel('orders')).toBe(false)
    })
  })

  describe('normalize', () => {
    it('should add prefix if missing', () => {
      expect(PrivateChannel.normalize('orders')).toBe('private-orders')
    })

    it('should not double prefix', () => {
      expect(PrivateChannel.normalize('private-orders')).toBe('private-orders')
    })
  })
})

describe('PresenceChannel', () => {
  let driver: MemoryDriver

  beforeEach(() => {
    driver = new MemoryDriver()
  })

  describe('constructor', () => {
    it('should add presence prefix', () => {
      const channel = new PresenceChannel('chat.1', driver)
      expect(channel.name).toBe('presence-chat.1')
    })

    it('should not double prefix', () => {
      const channel = new PresenceChannel('presence-chat.1', driver)
      expect(channel.name).toBe('presence-chat.1')
    })
  })

  describe('members', () => {
    it('should return channel members', async () => {
      const channel = new PresenceChannel('chat.1', driver)

      await channel.join({ id: 1, info: { name: 'Alice' } })
      await channel.join({ id: 2, info: { name: 'Bob' } })

      const members = channel.members()
      expect(members).toHaveLength(2)
    })
  })

  describe('join', () => {
    it('should add member to channel', async () => {
      const channel = new PresenceChannel('chat.1', driver)

      await channel.join({ id: 1, info: { name: 'Alice' } })

      expect(channel.members()).toHaveLength(1)
    })

    it('should broadcast presence:joining event', async () => {
      const channel = new PresenceChannel('chat.1', driver)
      // Nothing published before the join, so the one event below is its doing.
      expect(driver.getPublishedEventsFor(channel.name)).toHaveLength(0)

      await channel.join({ id: 1, info: { name: 'Alice' } })

      const joinEvents = driver.getPublishedEventsFor(channel.name)
      expect(joinEvents).toHaveLength(1)
      expect(joinEvents[0].event).toBe('presence:joining')
    })
  })

  describe('leave', () => {
    it('should remove member from channel', async () => {
      const channel = new PresenceChannel('chat.1', driver)

      await channel.join({ id: 1 })
      await channel.join({ id: 2 })
      await channel.leave(1)

      expect(channel.members()).toHaveLength(1)
      expect(channel.members()[0].id).toBe(2)
    })

    it('should broadcast presence:leaving event', async () => {
      const channel = new PresenceChannel('chat.1', driver)

      await channel.join({ id: 1, info: { name: 'Alice' } })
      driver.clearPublishedEvents()
      await channel.leave(1)

      const events = driver.getPublishedEventsFor(channel.name)
      expect(events).toHaveLength(1)
      expect(events[0].event).toBe('presence:leaving')
    })
  })

  describe('hasMember', () => {
    it('should return true if member exists', async () => {
      const channel = new PresenceChannel('chat.1', driver)
      await channel.join({ id: 1 })

      expect(channel.hasMember(1)).toBe(true)
      expect(channel.hasMember(2)).toBe(false)
    })
  })

  describe('getMember', () => {
    it('should return member by ID', async () => {
      const channel = new PresenceChannel('chat.1', driver)
      await channel.join({ id: 1, info: { name: 'Alice' } })

      const member = channel.getMember(1)
      expect(member?.info?.name).toBe('Alice')
    })

    it('should return undefined for unknown member', async () => {
      const channel = new PresenceChannel('chat.1', driver)

      expect(channel.getMember(999)).toBeUndefined()
    })
  })

  describe('count', () => {
    it('should return member count', async () => {
      const channel = new PresenceChannel('chat.1', driver)

      expect(channel.count()).toBe(0)

      await channel.join({ id: 1 })
      expect(channel.count()).toBe(1)

      await channel.join({ id: 2 })
      expect(channel.count()).toBe(2)
    })
  })

  describe('getBaseName', () => {
    it('should return name without prefix', () => {
      const channel = new PresenceChannel('chat.1', driver)
      expect(channel.getBaseName()).toBe('chat.1')
    })
  })

  describe('isPresenceChannel', () => {
    it('should return true for presence channels', () => {
      expect(PresenceChannel.isPresenceChannel('presence-chat')).toBe(true)
    })

    it('should return false for non-presence channels', () => {
      expect(PresenceChannel.isPresenceChannel('chat')).toBe(false)
    })
  })

  describe('normalize', () => {
    it('should add prefix if missing', () => {
      expect(PresenceChannel.normalize('chat')).toBe('presence-chat')
    })

    it('should not double prefix', () => {
      expect(PresenceChannel.normalize('presence-chat')).toBe('presence-chat')
    })
  })
})

describe('BroadcastManager', () => {
  let manager: BroadcastManager

  beforeEach(() => {
    manager = new BroadcastManager()
  })

  describe('constructor', () => {
    it('should register memory driver by default', () => {
      const driver = manager.driver()
      expect(driver).toBeInstanceOf(MemoryDriver)
    })

    it('should accept custom drivers', () => {
      const customDriver = new MemoryDriver()
      manager = new BroadcastManager({
        drivers: {
          custom: () => customDriver,
        },
        default: 'custom',
      })

      expect(manager.driver()).toBe(customDriver)
    })
  })

  describe('registerDriver', () => {
    it('should register a driver factory', () => {
      const customDriver = new MemoryDriver()
      manager.registerDriver('custom', () => customDriver)

      expect(manager.driver('custom')).toBe(customDriver)
    })
  })

  describe('driver', () => {
    it('should return default driver', () => {
      const driver = manager.driver()
      expect(driver).toBeInstanceOf(MemoryDriver)
    })

    it('should return named driver', () => {
      const customDriver = new MemoryDriver()
      manager.registerDriver('custom', () => customDriver)

      expect(manager.driver('custom')).toBe(customDriver)
    })

    it('should cache resolved drivers', () => {
      const driver1 = manager.driver()
      const driver2 = manager.driver()

      expect(driver1).toBe(driver2)
    })

    it('should throw for unknown driver', () => {
      expect(() => manager.driver('unknown')).toThrow(
        'Broadcast driver "unknown" not found'
      )
    })
  })

  describe('channel authorizers', () => {
    it('should register public channel', async () => {
      manager.channel('notifications', () => true)

      const result = await manager.authorize('notifications', null)
      expect(result).toBe(true)
    })

    it('should register private channel', async () => {
      manager.privateChannel('orders.{id}', (channel, user: any) => {
        return user?.id === 1
      })

      const result1 = await manager.authorize('private-orders.123', { id: 1 })
      const result2 = await manager.authorize('private-orders.123', { id: 2 })

      expect(result1).toBe(true)
      expect(result2).toBe(false)
    })

    it('should register presence channel', async () => {
      manager.presenceChannel('chat.{id}', (_channel, user: any) => {
        if (!user) return null
        return { id: user.id, info: { name: user.name } }
      })

      const result = await manager.authorize('presence-chat.1', {
        id: 1,
        name: 'Alice',
      })

      expect(result).toEqual({
        id: 1,
        info: { name: 'Alice' },
      })
    })

    it('should match wildcard patterns', async () => {
      manager.channel('events.*', () => true)

      const result1 = await manager.authorize('events.created', null)
      const result2 = await manager.authorize('events.updated', null)

      expect(result1).toBe(true)
      expect(result2).toBe(true)
    })

    it('should match parameter patterns', async () => {
      manager.channel('users.{userId}.events', () => true)

      const result = await manager.authorize('users.123.events', null)
      expect(result).toBe(true)
    })

    it('should return true for unregistered channels', async () => {
      const result = await manager.authorize('unregistered', null)
      expect(result).toBe(true)
    })

    it('should deny when an authorizer falls off the end without returning', async () => {
      // Callers treat anything but false/null as authorized, so undefined must not grant.
      manager.privateChannel('orders.{id}', (() => undefined) as unknown as () => boolean)

      const result = await manager.authorize('private-orders.123', { id: 1 })
      expect(result).toBe(false)
    })

    it('should deny a presence channel whose authorizer returns undefined', async () => {
      manager.presenceChannel('chat.{id}', (() => undefined) as unknown as () => null)

      const result = await manager.authorize('presence-chat.1', { id: 1 })
      expect(result).toBe(false)
    })
  })

  describe('broadcast', () => {
    it('should broadcast event to channel', async () => {
      const driver = manager.driver() as MemoryDriver

      await manager.broadcast('notifications', 'NewMessage', { text: 'Hello' })

      const events = driver.getPublishedEvents()
      expect(events).toHaveLength(1)
      expect(events[0].channel).toBe('notifications')
    })
  })

  describe('typed broadcaster', () => {
    it('broadcasts using typed helper wrappers', async () => {
      type Events = {
        announcements: {
          NewPost: { id: number; title: string }
        }
        'private-orders.1': {
          OrderUpdated: { status: string }
        }
        'presence-chat.1': {
          UserTyping: { userId: number }
        }
      }

      const manager = new BroadcastManager({
        default: 'memory',
        drivers: {
          memory: () => new MemoryDriver(),
        },
      })

      const typed = createTypedBroadcaster<Events>(manager)
      await typed.broadcast('announcements', 'NewPost', { id: 1, title: 'hello' })
      await typed.toPrivate('private-orders.1').broadcast('OrderUpdated', { status: 'paid' })
      await typed.toPresence('presence-chat.1').broadcast('UserTyping', { userId: 42 })

      const events = (manager.driver() as MemoryDriver).getPublishedEvents()
      expect(events).toHaveLength(3)
      expect(events[0].event).toBe('NewPost')
      expect(events[1].event).toBe('OrderUpdated')
      expect(events[2].event).toBe('UserTyping')
    })
  })

  describe('toChannel', () => {
    it('should return public channel', () => {
      const channel = manager.toChannel('notifications')

      expect(channel).toBeInstanceOf(Channel)
      expect(channel.name).toBe('notifications')
    })
  })

  describe('toPrivate', () => {
    it('should return private channel', () => {
      const channel = manager.toPrivate('orders.123')

      expect(channel).toBeInstanceOf(PrivateChannel)
      expect(channel.name).toBe('private-orders.123')
    })
  })

  describe('toPresence', () => {
    it('should return presence channel', () => {
      const channel = manager.toPresence('chat.1')

      expect(channel).toBeInstanceOf(PresenceChannel)
      expect(channel.name).toBe('presence-chat.1')
    })
  })

  describe('websocket clients', () => {
    it('should register and remove websocket clients', () => {
      const clientId = manager.registerWebSocketClient({
        send: () => {},
        close: () => {},
      })

      const client = manager.getWebSocketClient(clientId)
      expect(client).toBeDefined()
      expect(client?.id).toBe(clientId)
      expect(client?.channels.size).toBe(0)

      const removed = manager.removeWebSocketClient(clientId)
      expect(removed).toBe(true)
      expect(manager.getWebSocketClient(clientId)).toBeUndefined()
    })

    it('should subscribe websocket clients and fanout events', async () => {
      const received: Array<{ event: string; data: unknown }> = []
      const clientId = manager.registerWebSocketClient({
        send: (event, data) => {
          received.push({ event, data })
        },
        close: () => {},
      })

      const subscribed = manager.subscribeWebSocketClient(clientId, 'ws.notifications')
      expect(subscribed).toBe(true)

      await manager.broadcast('ws.notifications', 'NewMessage', { body: 'hello' })

      expect(received).toHaveLength(1)
      expect(received[0].event).toBe('NewMessage')
      expect(received[0].data).toEqual({ body: 'hello' })
    })

    it('should unsubscribe websocket clients from channels', async () => {
      const received: Array<{ event: string; data: unknown }> = []
      const clientId = manager.registerWebSocketClient({
        send: (event, data) => {
          received.push({ event, data })
        },
        close: () => {},
      })

      manager.subscribeWebSocketClient(clientId, 'ws.notifications')
      await manager.broadcast('ws.notifications', 'Before', { n: 1 })
      const unsubscribed = manager.unsubscribeWebSocketClient(clientId, 'ws.notifications')
      expect(unsubscribed).toBe(true)
      await manager.broadcast('ws.notifications', 'After', { n: 2 })

      expect(received).toHaveLength(1)
      expect(received[0].event).toBe('Before')
    })
  })
})

describe('Global broadcast manager', () => {
  it('should set and get global manager', () => {
    const manager = createBroadcastManager()
    setBroadcastManager(manager)

    expect(getBroadcastManager()).toBe(manager)
  })
})

describe('createBroadcastManager', () => {
  it('should create manager with options', () => {
    const customDriver = new MemoryDriver()
    const manager = createBroadcastManager({
      drivers: {
        custom: () => customDriver,
      },
      default: 'custom',
    })

    expect(manager.driver()).toBe(customDriver)
  })
})

describe('Integration scenarios', () => {
  it('should handle chat room scenario', async () => {
    const manager = new BroadcastManager()

    manager.presenceChannel('chat.{roomId}', (_channel, user: any) => {
      if (!user) return null
      return { id: user.id, info: { name: user.name } }
    })

    const chatRoom = manager.toPresence('chat.1')

    await chatRoom.join({ id: 1, info: { name: 'Alice' } })
    await chatRoom.join({ id: 2, info: { name: 'Bob' } })

    expect(chatRoom.count()).toBe(2)

    const received: BroadcastEvent[] = []
    ;(manager.driver() as MemoryDriver).subscribe(chatRoom.name, (e) =>
      received.push(e)
    )

    await chatRoom.broadcast('NewMessage', {
      userId: 1,
      content: 'Hello everyone!',
    })

    const messageEvents = received.filter((e) => e.event === 'NewMessage')
    expect(messageEvents).toHaveLength(1)

    await chatRoom.leave(1)
    expect(chatRoom.count()).toBe(1)
  })

  it('should handle order notification scenario', async () => {
    const manager = new BroadcastManager()

    manager.privateChannel('orders.{orderId}', (channel, user: any) => {
      return user?.id === 1
    })

    const canAccess = await manager.authorize('private-orders.123', { id: 1 })
    const cannotAccess = await manager.authorize('private-orders.123', { id: 2 })

    expect(canAccess).toBe(true)
    expect(cannotAccess).toBe(false)

    const orderChannel = manager.toPrivate('orders.123')
    await orderChannel.broadcast('OrderUpdated', {
      status: 'shipped',
      trackingNumber: 'ABC123',
    })

    const driver = manager.driver() as MemoryDriver
    const events = driver.getPublishedEventsFor(orderChannel.name)
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('OrderUpdated')
  })

  it('should handle public notification scenario', async () => {
    const manager = new BroadcastManager()

    manager.channel('announcements', () => true)

    const received: BroadcastEvent[] = []
    const driver = manager.driver() as MemoryDriver
    driver.subscribe('announcements', (e) => received.push(e))

    const channel = manager.toChannel('announcements')
    await channel.broadcast('SystemMaintenance', {
      message: 'Scheduled maintenance at midnight',
    })

    expect(received).toHaveLength(1)
    expect(received[0].event).toBe('SystemMaintenance')
  })
})
