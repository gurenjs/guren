/**
 * The functional APIs (`getBroadcastManager()`, `getLogManager()`,
 * `getNotificationManager()`) throw until something calls their setter, so a
 * provider that only binds into the container leaves them unusable in every app
 * that registers it.
 */
import { describe, expect, it } from 'bun:test'
import { Container } from '../../src/container/Container'
import type { ServiceProviderConstructor } from '../../src/container/ServiceProvider'
import { BroadcastServiceProvider } from '../../src/providers/BroadcastServiceProvider'
import { LogServiceProvider } from '../../src/providers/LogServiceProvider'
import { NotificationServiceProvider } from '../../src/providers/NotificationServiceProvider'
import { getBroadcastManager, setBroadcastManager } from '../../src/broadcasting'
import { getLogManager, setLogManager } from '../../src/logging'
import { getNotificationManager, setNotificationManager } from '../../src/notifications'
import { clearGlobalManager } from '../support/globals'

type GlobalManagerCase = [
  name: string,
  Provider: ServiceProviderConstructor,
  binding: string,
  read: () => unknown,
  clear: () => void,
]

const CASES: GlobalManagerCase[] = [
  [
    'BroadcastServiceProvider',
    BroadcastServiceProvider,
    'broadcast',
    getBroadcastManager,
    () => clearGlobalManager(setBroadcastManager),
  ],
  [
    'LogServiceProvider',
    LogServiceProvider,
    'log',
    getLogManager,
    () => clearGlobalManager(setLogManager),
  ],
  [
    'NotificationServiceProvider',
    NotificationServiceProvider,
    'notifications',
    getNotificationManager,
    () => clearGlobalManager(setNotificationManager),
  ],
]

describe('service provider globals', () => {
  it.each(CASES)(
    '%s should publish the bound manager as the global one at boot',
    async (_name, Provider, binding, read, clear) => {
      clear()
      const container = new Container()
      const provider = new Provider(container)
      await provider.register()
      await provider.boot?.()

      expect(read()).toBe(container.make(binding))
    },
  )
})
