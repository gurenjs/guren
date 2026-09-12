/**
 * `getBroadcastManager()`, `getLogManager()`, `getNotificationManager()`,
 * `getEncrypter()` and `getGate()` resolve from the default application's
 * container (RFC 0023 §4); providers publish no global. The setter still
 * answers for a process that binds nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ServiceProviderConstructor } from '../../src/container/ServiceProvider'
import { Application } from '../../src/http/Application'
import { resetDefaultApplication } from '../../src/http/default-application'
import { BroadcastServiceProvider } from '../../src/providers/BroadcastServiceProvider'
import { EncryptionServiceProvider } from '../../src/providers/EncryptionServiceProvider'
import { LogServiceProvider } from '../../src/providers/LogServiceProvider'
import { NotificationServiceProvider } from '../../src/providers/NotificationServiceProvider'
import { createBroadcastManager, getBroadcastManager, setBroadcastManager } from '../../src/broadcasting'
import { createLogManager, getLogManager, setLogManager } from '../../src/logging'
import { createNotificationManager, getNotificationManager, setNotificationManager } from '../../src/notifications'
import { createEncrypter, generateKey, getEncrypter, setEncrypter } from '../../src/encryption'
import { createGate, getGate, setGate } from '../../src/authorization'
import { clearGlobalManager } from '../support/globals'

process.env.APP_KEY ??= 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

type GlobalManagerCase = [
  name: string,
  providers: ServiceProviderConstructor[],
  binding: string,
  read: () => unknown,
  set: (value: never) => void,
  build: () => unknown,
]

const CASES: GlobalManagerCase[] = [
  ['getBroadcastManager', [BroadcastServiceProvider], 'broadcast', getBroadcastManager, setBroadcastManager, () => createBroadcastManager()],
  ['getLogManager', [LogServiceProvider], 'log', getLogManager, setLogManager, () => createLogManager({ default: 'console', channels: { console: { driver: 'console' } } })],
  ['getNotificationManager', [NotificationServiceProvider], 'notifications', getNotificationManager, setNotificationManager, () => createNotificationManager()],
  ['getEncrypter', [EncryptionServiceProvider], 'encrypter', getEncrypter, setEncrypter, () => createEncrypter({ key: generateKey() })],
  ['getGate', [], 'gate', getGate, setGate, () => createGate()],
]

describe('the functional getters', () => {
  beforeEach(() => {
    resetDefaultApplication()
  })

  afterEach(() => {
    resetDefaultApplication()
  })

  it.each(CASES)('%s reads the default application\'s binding, which no provider publishes globally', async (_name, providers, binding, read, set) => {
    clearGlobalManager(set)
    const app = new Application({ providers })
    await app.boot()

    expect(read()).toBe(app.container.make(binding))

    resetDefaultApplication()
    expect(() => read()).toThrow('not')
  })

  it.each(CASES)('%s keeps answering a hand-set instance for a process that binds nothing', (_name, _providers, _binding, read, set, build) => {
    const instance = build()
    set(instance as never)

    expect(read()).toBe(instance)

    clearGlobalManager(set)
  })

  it.each(CASES)('%s prefers the default application\'s binding over a hand-set instance', async (_name, providers, binding, read, set, build) => {
    set(build() as never)
    const app = new Application({ providers })
    await app.boot()

    expect(read()).toBe(app.container.make(binding))

    clearGlobalManager(set)
  })
})
