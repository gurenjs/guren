import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createApp,
  MemoryDriver,
  MemoryTransport,
  type CacheManager,
  type MailManager,
  type OAuthManager,
  type QueueManager,
  type StorageManager,
} from '@guren/core'

import cache from '../../config/cache.js'
import env from '../../config/env.js'
import mail from '../../config/mail.js'
import oauth from '../../config/oauth.js'
import queue from '../../config/queue.js'
import storage from '../../config/storage.js'

// Through createApp: a definition binds its manager only when createApp resolves it.
async function boot() {
  const app = createApp({ env, config: [cache, mail, queue, storage, oauth] })
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

  it('registers an OAuth provider only when all three of its keys are set', async () => {
    vi.stubEnv('OAUTH_GITHUB_CLIENT_ID', 'id')
    vi.stubEnv('OAUTH_GITHUB_CLIENT_SECRET', 'secret')
    vi.stubEnv('OAUTH_GITHUB_REDIRECT_URI', 'http://localhost:3333/auth/github/callback')
    vi.stubEnv('OAUTH_GOOGLE_CLIENT_ID', 'id')
    vi.stubEnv('OAUTH_GOOGLE_CLIENT_SECRET', '')
    const container = await boot()

    expect(container.make<OAuthManager>('oauth').providerNames()).toEqual(['github'])
  })

  it('fails the boot on a mail transport or queue driver config/*.ts does not declare', async () => {
    vi.stubEnv('MAIL_MAILER', 'smtp')
    await expect(boot()).rejects.toThrow('MAIL_MAILER="smtp" is not a declared transport')

    vi.stubEnv('MAIL_MAILER', 'log')
    vi.stubEnv('QUEUE_CONNECTION', 'redis')
    await expect(boot()).rejects.toThrow('QUEUE_CONNECTION="redis" is not a declared driver')
  })
})
