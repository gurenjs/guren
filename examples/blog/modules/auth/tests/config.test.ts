import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, type OAuthManager } from '@guren/core'

import env from '../../../config/env.js'
import { authModule } from '../index.js'

// Through the module, as src/app.ts mounts it: the OAuth definition is the
// module's own, and createApp({ config }) does not list it.
async function boot() {
  const app = createApp({ env, modules: [authModule] })
  await app.boot()
  return app.container
}

describe('auth module config', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
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
})
