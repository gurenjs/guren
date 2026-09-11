/**
 * The functional APIs (`getBroadcastManager()`, `getNotificationManager()`)
 * throw until something calls their setter, so a provider that only binds into
 * the container leaves them unusable in every app that registers it.
 */
import { describe, expect, it } from 'bun:test'
import { Container } from '../../src/container/Container'
import { BroadcastServiceProvider } from '../../src/providers/BroadcastServiceProvider'
import { NotificationServiceProvider } from '../../src/providers/NotificationServiceProvider'
import { getBroadcastManager, type BroadcastManager } from '../../src/broadcasting'
import { getNotificationManager, type NotificationManager } from '../../src/notifications'

describe('BroadcastServiceProvider', () => {
  it('should publish the bound manager as the global one at boot', () => {
    const container = new Container()
    const provider = new BroadcastServiceProvider(container)
    provider.register()
    provider.boot()

    expect(getBroadcastManager()).toBe(container.make<BroadcastManager>('broadcast'))
  })
})

describe('NotificationServiceProvider', () => {
  it('should publish the bound manager as the global one at boot', () => {
    const container = new Container()
    const provider = new NotificationServiceProvider(container)
    provider.register()
    provider.boot()

    expect(getNotificationManager()).toBe(container.make<NotificationManager>('notifications'))
  })
})
