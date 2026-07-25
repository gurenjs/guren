import { beforeEach, describe, expect, it, mock } from 'bun:test'
import {
  OAuthManager,
  MemoryOAuthStateStore,
  buildOAuthAuthorizeUrl,
  createDiscordOAuthProviderConfig,
  createGitHubOAuthProviderConfig,
  createGoogleOAuthProviderConfig,
  createOAuthState,
  verifyOAuthState,
  sanitizeOAuthRedirect,
  type OAuthProviderConfig,
} from '../../src/auth/oauth'
import { hashToken } from '../../src/auth/utils'

describe('oauth helpers', () => {
  it('builds authorize URL with required params and scopes', () => {
    const config: OAuthProviderConfig = {
      clientId: 'client-id',
      clientSecret: 'secret',
      redirectUri: 'https://example.com/auth/callback',
      authorizeUrl: 'https://provider.example.com/oauth/authorize',
      tokenUrl: 'https://provider.example.com/oauth/token',
      userInfoUrl: 'https://provider.example.com/me',
      scopes: ['profile', 'email'],
    }

    const url = buildOAuthAuthorizeUrl(config, 'state-123')
    const parsed = new URL(url)

    expect(parsed.searchParams.get('client_id')).toBe('client-id')
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://example.com/auth/callback')
    expect(parsed.searchParams.get('state')).toBe('state-123')
    expect(parsed.searchParams.get('scope')).toBe('profile email')
  })

  it('creates and verifies one-time state payloads', async () => {
    const store = new MemoryOAuthStateStore()
    const { state } = await createOAuthState('github', store, { expiresIn: 60_000 }, '/dashboard')

    const payload = await verifyOAuthState(state, 'github', store, {})
    expect(payload?.provider).toBe('github')
    expect(payload?.redirectTo).toBe('/dashboard')

    const secondUse = await verifyOAuthState(state, 'github', store, {})
    expect(secondUse).toBeNull()
  })

  it('drops unsafe redirectTo values when creating state', async () => {
    const store = new MemoryOAuthStateStore()
    const { state } = await createOAuthState('github', store, {}, 'https://evil.example.com/phish')

    const payload = await verifyOAuthState(state, 'github', store, {})
    expect(payload?.redirectTo).toBeUndefined()
  })

  it('re-sanitizes redirectTo on verify for custom stores', async () => {
    const store = new MemoryOAuthStateStore()
    const { state } = await createOAuthState('github', store, {}, '/ok', 'fixed-state')

    // Overwrite the stored payload with an unsafe target, simulating a custom
    // store (or a state persisted before an allowlist change).
    await store.store(hashToken(state, 'sha256'), {
      provider: 'github',
      redirectTo: '//evil.example.com',
      expiresAt: new Date(Date.now() + 60_000),
    })

    const verified = await verifyOAuthState(state, 'github', store, {})
    expect(verified?.provider).toBe('github')
    expect(verified?.redirectTo).toBeUndefined()
  })
})

describe('sanitizeOAuthRedirect', () => {
  it('allows app-relative paths', () => {
    expect(sanitizeOAuthRedirect('/dashboard')).toBe('/dashboard')
    expect(sanitizeOAuthRedirect('/settings?tab=profile')).toBe('/settings?tab=profile')
  })

  it('rejects protocol-relative and backslash-crafted URLs', () => {
    expect(sanitizeOAuthRedirect('//evil.example.com')).toBeUndefined()
    expect(sanitizeOAuthRedirect('/\\evil.example.com')).toBeUndefined()
    expect(sanitizeOAuthRedirect('\\/evil.example.com')).toBeUndefined()
  })

  it('rejects absolute URLs and non-http schemes by default', () => {
    expect(sanitizeOAuthRedirect('https://evil.example.com/phish')).toBeUndefined()
    expect(sanitizeOAuthRedirect('javascript:alert(1)')).toBeUndefined()
    expect(sanitizeOAuthRedirect('data:text/html,x')).toBeUndefined()
  })

  it('allows allowlisted hosts including wildcards', () => {
    expect(sanitizeOAuthRedirect('https://app.example.com/next', ['app.example.com'])).toBe(
      'https://app.example.com/next',
    )
    expect(sanitizeOAuthRedirect('https://staging.example.com/next', ['*.example.com'])).toBe(
      'https://staging.example.com/next',
    )
    expect(sanitizeOAuthRedirect('https://example.com.evil.net/', ['*.example.com'])).toBeUndefined()
    expect(sanitizeOAuthRedirect('ftp://app.example.com/', ['app.example.com'])).toBeUndefined()
  })

  it('returns undefined for empty values', () => {
    expect(sanitizeOAuthRedirect(undefined)).toBeUndefined()
    expect(sanitizeOAuthRedirect('   ')).toBeUndefined()
  })
})

describe('OAuthManager', () => {
  const githubConfig = createGitHubOAuthProviderConfig({
    clientId: 'gh-id',
    clientSecret: 'gh-secret',
    redirectUri: 'https://app.example.com/auth/github/callback',
  })

  const installOAuthFetchMock = (
    tokenResponse: Record<string, unknown>,
    userResponse: Record<string, unknown>,
  ) => {
    const fetchMock = mock(async (input: string) => {
      const body = input.includes('/access_token') ? tokenResponse : userResponse
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    ;(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch
  }

  beforeEach(() => {
    mock.restore()
  })

  it('registers providers and builds redirect URLs', async () => {
    const manager = new OAuthManager({
      stateStore: new MemoryOAuthStateStore(),
    })
    manager.registerProvider('github', githubConfig)

    const result = await manager.authorize('github', { redirectTo: '/settings' })
    expect(result.url).toContain('https://github.com/login/oauth/authorize')
    expect(result.url).toContain('state=')
  })

  it('exchanges callback code and returns mapped profile', async () => {
    const manager = new OAuthManager({
      stateStore: new MemoryOAuthStateStore(),
    })
    manager.registerProvider('github', githubConfig)

    installOAuthFetchMock(
      { access_token: 'token-123', token_type: 'bearer', scope: 'read:user' },
      { id: 42, email: 'octo@example.com', name: 'Octo Cat', avatar_url: 'https://example.com/avatar.png' },
    )

    const { state } = await manager.authorize('github')
    const profile = await manager.user('github', { code: 'auth-code', state })

    expect(profile.id).toBe('42')
    expect(profile.email).toBe('octo@example.com')
    expect(profile.token.accessToken).toBe('token-123')
  })

  it('falls back to /user/emails when the GitHub profile email is private', async () => {
    const manager = new OAuthManager({
      stateStore: new MemoryOAuthStateStore(),
    })
    manager.registerProvider('github', githubConfig)

    const fetchMock = mock(async (input: string) => {
      const body = input.includes('/access_token')
        ? { access_token: 'token-123' }
        : input.includes('/user/emails')
          ? [
              { email: 'secondary@example.com', primary: false, verified: true },
              { email: 'unverified@example.com', primary: true, verified: false },
              { email: 'primary@example.com', primary: true, verified: true },
            ]
          : { id: 42, email: null, name: 'Private Octo' }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    ;(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch

    const { state } = await manager.authorize('github')
    const profile = await manager.user('github', { code: 'auth-code', state })

    expect(profile.email).toBe('primary@example.com')
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/user/emails'))).toBe(true)
  })

  it('leaves the profile email undefined when the fallback finds nothing', async () => {
    const manager = new OAuthManager({
      stateStore: new MemoryOAuthStateStore(),
    })
    manager.registerProvider('github', githubConfig)

    installOAuthFetchMock({ access_token: 'token-123' }, { id: 42 })

    const { state } = await manager.authorize('github')
    const profile = await manager.user('github', { code: 'auth-code', state })

    expect(profile.email).toBeUndefined()
  })

  it('round-trips sanitized redirectTo through authorize and handleCallback', async () => {
    const manager = new OAuthManager({
      stateStore: new MemoryOAuthStateStore(),
      stateConfig: { allowedRedirectHosts: ['trusted.example.com'] },
    })
    manager.registerProvider('github', githubConfig)
    installOAuthFetchMock({ access_token: 'token-123' }, { id: 42 })

    const roundTrip = async (redirectTo: string) => {
      const { state } = await manager.authorize('github', { redirectTo })
      return manager.handleCallback('github', { code: 'auth-code', state })
    }

    const relative = await roundTrip('/dashboard')
    expect(relative.redirectTo).toBe('/dashboard')
    expect(relative.profile.id).toBe('42')

    const unsafe = await roundTrip('https://evil.example.com')
    expect(unsafe.redirectTo).toBeUndefined()

    const allowlisted = await roundTrip('https://trusted.example.com/welcome')
    expect(allowlisted.redirectTo).toBe('https://trusted.example.com/welcome')
  })

  it('exposes provider presets for google and discord', () => {
    const google = createGoogleOAuthProviderConfig({
      clientId: 'g-id',
      clientSecret: 'g-secret',
      redirectUri: 'https://example.com/auth/google/callback',
    })
    const discord = createDiscordOAuthProviderConfig({
      clientId: 'd-id',
      clientSecret: 'd-secret',
      redirectUri: 'https://example.com/auth/discord/callback',
    })

    expect(google.authorizeUrl).toContain('accounts.google.com')
    expect(discord.authorizeUrl).toContain('discord.com')
  })
})
