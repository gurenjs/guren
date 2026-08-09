import { beforeEach, describe, expect, it, mock } from 'bun:test'
import {
  OAuthManager,
  MemoryOAuthStateStore,
  OAUTH_SESSION_BINDING_KEY,
  buildOAuthAuthorizeUrl,
  createDiscordOAuthProviderConfig,
  createGitHubOAuthProviderConfig,
  createGoogleOAuthProviderConfig,
  createOAuthState,
  verifyOAuthState,
  sanitizeOAuthRedirect,
  type OAuthBindingSession,
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

  // Without a binding, `state` is unguessable and single-use but transferable:
  // the attacker starts a flow, keeps their own `code` unconsumed, and walks
  // the victim's browser through the callback — logging the victim into the
  // attacker's account.
  it('rejects a state bound to another browser', async () => {
    const store = new MemoryOAuthStateStore()
    const { state } = await createOAuthState('github', store, {}, '/dashboard', undefined, 'attacker-session')

    expect(await verifyOAuthState(state, 'github', store, {}, 'victim-session')).toBeNull()
  })

  it('rejects a bound state presented with no binding at all', async () => {
    const store = new MemoryOAuthStateStore()
    const { state } = await createOAuthState('github', store, {}, undefined, undefined, 'starting-session')

    expect(await verifyOAuthState(state, 'github', store, {})).toBeNull()
  })

  it('accepts the browser that started the flow', async () => {
    const store = new MemoryOAuthStateStore()
    const { state } = await createOAuthState('github', store, {}, '/dashboard', undefined, 'starting-session')

    const payload = await verifyOAuthState(state, 'github', store, {}, 'starting-session')
    expect(payload?.provider).toBe('github')
    expect(payload?.redirectTo).toBe('/dashboard')
  })

  it('stores only the hash of the binding', async () => {
    const store = new MemoryOAuthStateStore()
    const { state } = await createOAuthState('github', store, {}, undefined, 'fixed-state', 'session-abc')

    const stored = await store.find(hashToken('fixed-state'))
    expect(stored?.binding).toBe(hashToken('session-abc'))
    expect(stored?.binding).not.toBe('session-abc')
    expect(state).toBe('fixed-state')
  })

  // Apps written against the previous API pass no binding at all. They stay
  // exposed to the transfer above — authorize() warns about it — but must not
  // break on upgrade.
  // A store that drops `binding` reverts the protection with no other signal,
  // so the mismatch between "bound at authorize" and "unbound at callback" is
  // reported rather than passing silently.
  it('warns when a bound flow comes back from the store unbound', async () => {
    const store = new MemoryOAuthStateStore()
    const original = console.warn
    const warnings: string[] = []
    console.warn = (message: unknown) => { warnings.push(String(message)) }

    try {
      const { state } = await createOAuthState('github', store, {}, undefined, 'dropped-state')
      // Simulate the store losing the field: the state was minted unbound, but
      // the caller presents one, which is the shape a dropping store produces.
      expect(await verifyOAuthState(state, 'github', store, {}, 'session-abc')).not.toBeNull()
    } finally {
      console.warn = original
    }

    expect(warnings.some((line) => line.includes('without its binding'))).toBe(true)
  })

  it('still verifies a state created without a binding', async () => {
    const store = new MemoryOAuthStateStore()
    const { state } = await createOAuthState('github', store, {})

    expect(await verifyOAuthState(state, 'github', store, {})).not.toBeNull()
  })

  it('drops unsafe redirectTo values when creating state', async () => {
    const store = new MemoryOAuthStateStore()
    const { state } = await createOAuthState('github', store, {}, 'https://evil.example.com/phish')

    const payload = await verifyOAuthState(state, 'github', store, {})
    expect(payload?.redirectTo).toBeUndefined()
  })

  it('consume returns the payload exactly once under concurrency', async () => {
    const store = new MemoryOAuthStateStore()
    await store.store('hash-1', {
      provider: 'github',
      redirectTo: '/dashboard',
      expiresAt: new Date(Date.now() + 60_000),
    })

    const results = await Promise.all([store.consume('hash-1'), store.consume('hash-1')])

    const winners = results.filter((r) => r !== null)
    expect(winners).toHaveLength(1)
    expect(winners[0]?.provider).toBe('github')
    expect(await store.find('hash-1')).toBeNull()
  })

  it('consume returns null for expired state and removes it', async () => {
    const store = new MemoryOAuthStateStore()
    await store.store('hash-expired', {
      provider: 'github',
      expiresAt: new Date(Date.now() - 1000),
    })

    expect(await store.consume('hash-expired')).toBeNull()
    expect(await store.find('hash-expired')).toBeNull()
  })

  it('only one concurrent verifyOAuthState call succeeds for the same state', async () => {
    const store = new MemoryOAuthStateStore()
    const { state } = await createOAuthState('github', store, { expiresIn: 60_000 }, '/dashboard')

    const results = await Promise.all([
      verifyOAuthState(state, 'github', store, {}),
      verifyOAuthState(state, 'github', store, {}),
    ])

    expect(results.filter((r) => r !== null)).toHaveLength(1)
  })

  it('verifyOAuthState prefers consume over find/delete when available', async () => {
    const payload = {
      provider: 'github',
      redirectTo: '/next',
      expiresAt: new Date(Date.now() + 60_000),
    }
    const calls: string[] = []
    const store = {
      store: async () => {},
      find: async () => {
        calls.push('find')
        return payload
      },
      delete: async () => {
        calls.push('delete')
      },
      consume: async () => {
        calls.push('consume')
        return payload
      },
    }

    const verified = await verifyOAuthState('some-state', 'github', store, {})

    expect(verified?.redirectTo).toBe('/next')
    expect(calls).toEqual(['consume'])
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

  describe('session-bound flows', () => {
    const createSessionStub = (): OAuthBindingSession & { data: Map<string, unknown> } => {
      const data = new Map<string, unknown>()
      return {
        data,
        get: <T,>(key: string) => data.get(key) as T | undefined,
        set: (key: string, value: unknown) => { data.set(key, value) },
        forget: (key: string) => { data.delete(key) },
      }
    }

    const createManager = () => {
      const manager = new OAuthManager({ stateStore: new MemoryOAuthStateStore() })
      manager.registerProvider('github', githubConfig)
      return manager
    }

    it('mints a binding into the session and accepts the callback carrying it', async () => {
      const manager = createManager()
      installOAuthFetchMock({ access_token: 'token-123' }, { id: 42 })

      const session = createSessionStub()
      const { state } = await manager.authorize('github', { session })
      // Filed under the state it belongs to, so concurrent flows coexist.
      expect(session.get<unknown[]>(OAUTH_SESSION_BINDING_KEY)).toHaveLength(1)

      const { profile } = await manager.handleCallback('github', { code: 'auth-code', state, session })
      expect(profile.id).toBe('42')
    })

    it('rejects the callback when a different session presents the state', async () => {
      const manager = createManager()
      installOAuthFetchMock({ access_token: 'token-123' }, { id: 42 })

      const startingSession = createSessionStub()
      const { state } = await manager.authorize('github', { session: startingSession })

      // The victim's browser has its own session, which never saw authorize().
      const otherSession = createSessionStub()
      await expect(
        manager.handleCallback('github', { code: 'auth-code', state, session: otherSession }),
      ).rejects.toThrow('Invalid or expired OAuth state.')
    })

    // Bindings are filed under the state they belong to, so a callback
    // carrying a state this browser never started cannot strip the binding of
    // the flow it did start. Otherwise anyone could navigate a visitor to
    // `/callback?code=x&state=x` mid-login and lock them out of their own.
    it('leaves an unrelated flow untouched when a forged callback arrives', async () => {
      const manager = createManager()
      installOAuthFetchMock({ access_token: 'token-123' }, { id: 42 })

      const session = createSessionStub()
      const { state } = await manager.authorize('github', { session })

      await expect(
        manager.handleCallback('github', { code: 'auth-code', state: 'forged-state', session }),
      ).rejects.toThrow('Invalid or expired OAuth state.')

      const { profile } = await manager.handleCallback('github', { code: 'auth-code', state, session })
      expect(profile.id).toBe('42')
    })

    // One slot per browser meant the second authorize() overwrote the first,
    // so two tabs — or a visitor who picks a different provider — could not
    // both finish. Callback order must not matter either.
    it('keeps concurrent flows in the same browser independent', async () => {
      const manager = createManager()
      installOAuthFetchMock({ access_token: 'token-123' }, { id: 42 })

      const session = createSessionStub()
      const first = await manager.authorize('github', { session })
      const second = await manager.authorize('github', { session, redirectTo: '/second' })

      // Oldest first: the order that used to fail both.
      const firstResult = await manager.handleCallback('github', { code: 'auth-code', state: first.state, session })
      const secondResult = await manager.handleCallback('github', { code: 'auth-code', state: second.state, session })

      expect(firstResult.profile.id).toBe('42')
      expect(secondResult.profile.id).toBe('42')
    })

    it('drops the binding once its flow completes', async () => {
      const manager = createManager()
      installOAuthFetchMock({ access_token: 'token-123' }, { id: 42 })

      const session = createSessionStub()
      const { state } = await manager.authorize('github', { session })
      await manager.handleCallback('github', { code: 'auth-code', state, session })

      expect(session.get<unknown[]>(OAUTH_SESSION_BINDING_KEY)).toEqual([])
    })

    it('bounds how many unfinished flows a browser accumulates', async () => {
      const manager = createManager()
      installOAuthFetchMock({ access_token: 'token-123' }, { id: 42 })

      const session = createSessionStub()
      for (let i = 0; i < 8; i++) {
        await manager.authorize('github', { session })
      }

      expect(session.get<unknown[]>(OAUTH_SESSION_BINDING_KEY)).toHaveLength(5)
    })

    it('prefers an explicit bindTo over the session', async () => {
      const manager = createManager()
      installOAuthFetchMock({ access_token: 'token-123' }, { id: 42 })

      const session = createSessionStub()
      const { state } = await manager.authorize('github', { bindTo: 'external-value', session })
      // The session was not written to — the caller owns the binding.
      expect(session.data.size).toBe(0)

      const { profile } = await manager.handleCallback('github', { code: 'auth-code', state, bindTo: 'external-value' })
      expect(profile.id).toBe('42')
    })
  })

  it('reports the provider verification signal from the configured key', async () => {
    // Discord names it `verified`, not OIDC's `email_verified` — the preset
    // declares the key so the shared mapper never has to know about it.
    const discordConfig = createDiscordOAuthProviderConfig({
      clientId: 'd-id',
      clientSecret: 'd-secret',
      redirectUri: 'https://app.example.com/auth/discord/callback',
    })
    const manager = new OAuthManager({ stateStore: new MemoryOAuthStateStore() })
    manager.registerProvider('discord', discordConfig)

    // Discord's token endpoint is `/api/oauth2/token`, which the shared
    // `installOAuthFetchMock` helper would misroute to the userinfo body.
    const fetchMock = mock(async (input: string) => {
      const body = input.includes('/oauth2/token')
        ? { access_token: 'token-123' }
        : { id: '99', email: 'user@example.com', verified: false }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    ;(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch

    const { state } = await manager.authorize('discord')
    const profile = await manager.user('discord', { code: 'auth-code', state })

    expect(profile.email).toBe('user@example.com')
    expect(profile.emailVerified).toBe(false)
  })

  it('reads the OIDC email_verified claim by default', async () => {
    const oidcConfig: OAuthProviderConfig = {
      clientId: 'oidc-id',
      clientSecret: 'oidc-secret',
      redirectUri: 'https://app.example.com/auth/oidc/callback',
      authorizeUrl: 'https://provider.example.com/authorize',
      tokenUrl: 'https://provider.example.com/access_token',
      userInfoUrl: 'https://provider.example.com/userinfo',
    }
    const manager = new OAuthManager({ stateStore: new MemoryOAuthStateStore() })
    manager.registerProvider('oidc', oidcConfig)

    installOAuthFetchMock(
      { access_token: 'token-123' },
      { sub: 'user-1', email: 'user@example.com', email_verified: true },
    )

    const { state } = await manager.authorize('oidc')
    expect((await manager.user('oidc', { code: 'auth-code', state })).emailVerified).toBe(true)

    // Non-boolean values carry no signal — the field stays undefined rather
    // than coercing a string into a verification claim.
    installOAuthFetchMock(
      { access_token: 'token-123' },
      { sub: 'user-1', email: 'user@example.com', email_verified: 'true' },
    )
    const { state: second } = await manager.authorize('oidc')
    expect((await manager.user('oidc', { code: 'auth-code', state: second })).emailVerified).toBeUndefined()
  })

  it('leaves emailVerified undefined when the provider sends no signal', async () => {
    const manager = new OAuthManager({ stateStore: new MemoryOAuthStateStore() })
    manager.registerProvider('github', githubConfig)

    // GitHub's /user carries no verification field. Consumers must be able to
    // tell "no signal" apart from "the provider says no".
    installOAuthFetchMock(
      { access_token: 'token-123' },
      { id: 42, email: 'octo@example.com', name: 'Octo Cat' },
    )

    const { state } = await manager.authorize('github')
    const profile = await manager.user('github', { code: 'auth-code', state })

    expect(profile.email).toBe('octo@example.com')
    expect(profile.emailVerified).toBeUndefined()
  })

  it('marks a fallback email as verified', async () => {
    const manager = new OAuthManager({ stateStore: new MemoryOAuthStateStore() })
    manager.registerProvider('github', githubConfig)

    const fetchMock = mock(async (input: string) => {
      const body = input.includes('/access_token')
        ? { access_token: 'token-123' }
        : input.includes('/user/emails')
          ? [{ email: 'primary@example.com', primary: true, verified: true }]
          : { id: 42, email: null }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    ;(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch

    const { state } = await manager.authorize('github')
    const profile = await manager.user('github', { code: 'auth-code', state })

    // GitHub's lookup filters on the address's own `verified` flag, so it
    // returns the object form and can claim verification for it.
    expect(profile.email).toBe('primary@example.com')
    expect(profile.emailVerified).toBe(true)
  })

  it('makes no verification claim for a fallback that returns a bare string', async () => {
    const manager = new OAuthManager({ stateStore: new MemoryOAuthStateStore() })
    manager.registerProvider('custom', {
      ...githubConfig,
      // The original signature every pre-existing implementation was written
      // against. It promises nothing about verification, so neither do we.
      fetchFallbackEmail: async () => 'from-elsewhere@example.com',
    })

    installOAuthFetchMock({ access_token: 'token-123' }, { id: 42, email: null })

    const { state } = await manager.authorize('custom')
    const profile = await manager.user('custom', { code: 'auth-code', state })

    expect(profile.email).toBe('from-elsewhere@example.com')
    expect(profile.emailVerified).toBeUndefined()
  })

  it('honors an explicit false from a fallback', async () => {
    const manager = new OAuthManager({ stateStore: new MemoryOAuthStateStore() })
    manager.registerProvider('custom', {
      ...githubConfig,
      fetchFallbackEmail: async () => ({ email: 'unverified@example.com', emailVerified: false }),
    })

    installOAuthFetchMock({ access_token: 'token-123' }, { id: 42, email: null })

    const { state } = await manager.authorize('custom')
    const profile = await manager.user('custom', { code: 'auth-code', state })

    expect(profile.email).toBe('unverified@example.com')
    expect(profile.emailVerified).toBe(false)
  })

  it('does not overwrite emailVerified set by a custom mapProfile', async () => {
    const manager = new OAuthManager({ stateStore: new MemoryOAuthStateStore() })
    manager.registerProvider('custom', {
      ...githubConfig,
      emailVerifiedKey: 'verified',
      mapProfile: (raw, token) => ({
        id: String(raw.id),
        email: 'mapped@example.com',
        emailVerified: true,
        token,
        raw,
      }),
    })

    installOAuthFetchMock({ access_token: 'token-123' }, { id: 42, verified: false })

    const { state } = await manager.authorize('custom')
    const profile = await manager.user('custom', { code: 'auth-code', state })

    expect(profile.email).toBe('mapped@example.com')
    expect(profile.emailVerified).toBe(true)
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
    // Each preset declares how to read its own verification signal.
    expect(google.emailVerifiedKey).toBe('email_verified')
    expect(discord.emailVerifiedKey).toBe('verified')
  })
})
