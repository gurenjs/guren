import { describe, expect, it } from 'bun:test'
import { Container, SyncDriver, type AppEnv, type QueueManager } from '@guren/core'
import { loadConfigTemplate } from './helpers'

const queueConfig = await loadConfigTemplate('queue')

// The template itself: scaffold-output.test.ts pins the written file byte-identical to it.
describe('scaffolded queue config definition', () => {
  it('binds a manager on the driver QUEUE_CONNECTION names', () => {
    const container = new Container()
    queueConfig.bind(container, queueConfig.resolve({ QUEUE_CONNECTION: 'sync' } as AppEnv))

    expect(container.make<QueueManager>('queue').driver()).toBeInstanceOf(SyncDriver)
  })

  // The manager itself accepts any name and throws only on the first dispatch.
  it('refuses a QUEUE_CONNECTION it does not declare at resolve', () => {
    expect(() => queueConfig.resolve({ QUEUE_CONNECTION: 'redis' } as AppEnv)).toThrow('QUEUE_CONNECTION="redis" is not a declared driver')
  })
})
