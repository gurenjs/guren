import { describe, expect, it } from 'vitest'
import { createApp, MemoryDriver, type CacheManager, type MailManager, type QueueManager, type StorageManager } from '@guren/core'

import cache from '../../config/cache.js'
import mail from '../../config/mail.js'
import queue from '../../config/queue.js'
import storage from '../../config/storage.js'

// Through createApp, as src/app.ts lists them: a definition binds its manager only when resolved there.
describe('API config definitions', () => {
  it('bind the cache, mail, queue and storage managers the providers used to', async () => {
    const app = createApp({ config: [cache, mail, queue, storage] })
    await app.boot()

    expect(app.container.make<CacheManager>('cache')).toBeDefined()
    expect(app.container.make<MailManager>('mail').transport()).toBeDefined()
    expect(app.container.make<QueueManager>('queue').driver()).toBeInstanceOf(MemoryDriver)
    expect(app.container.make<StorageManager>('storage').disk('public')).toBeDefined()
  })
})
