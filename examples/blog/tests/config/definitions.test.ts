import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createApp,
  MemoryDriver,
  MemoryTransport,
  type CacheManager,
  type MailManager,
  type QueueManager,
  type StorageManager,
} from '@guren/core'

import cache from '../../config/cache.js'
import env from '../../config/env.js'
import mail from '../../config/mail.js'
import queue from '../../config/queue.js'
import storage from '../../config/storage.js'

// Through createApp: a definition binds its manager only when createApp resolves it.
async function boot() {
  const app = createApp({ env, config: [cache, mail, queue, storage] })
  await app.boot()
  return app.container
}

describe('Blog config definitions', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('bind the cache, mail, queue and storage managers from the environment', async () => {
    vi.stubEnv('MAIL_MAILER', 'memory')
    vi.stubEnv('QUEUE_CONNECTION', 'memory')
    // Selecting redis must not dial it: the client is built when the store is first resolved.
    vi.stubEnv('CACHE_STORE', 'redis')
    const container = await boot()

    expect(container.make<CacheManager>('cache').getDefaultStoreName()).toBe('redis')
    expect(container.make<MailManager>('mail').transport()).toBeInstanceOf(MemoryTransport)
    expect(container.make<QueueManager>('queue').driver()).toBeInstanceOf(MemoryDriver)
    expect(container.make<StorageManager>('storage').disk('public')).toBeDefined()
  })

  it('keeps a blank MAIL_FROM_NAME blank', async () => {
    vi.stubEnv('MAIL_FROM_NAME', '')
    expect(env.parse(undefined, { mode: 'report' }).values.MAIL_FROM_NAME).toBe('')
  })

  it('fails the boot on a mail transport or queue driver config/*.ts does not declare', async () => {
    vi.stubEnv('MAIL_MAILER', 'smtp')
    await expect(boot()).rejects.toThrow('MAIL_MAILER="smtp" is not a declared transport')

    vi.stubEnv('MAIL_MAILER', 'log')
    vi.stubEnv('QUEUE_CONNECTION', 'redis')
    await expect(boot()).rejects.toThrow('QUEUE_CONNECTION="redis" is not a declared driver')
  })
})
