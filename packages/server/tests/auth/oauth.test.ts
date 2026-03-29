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
  type OAuthProviderConfig,
} from '../../src/auth/oauth'

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
})

describe('OAuthManager', () => {
  const githubConfig = createGitHubOAuthProviderConfig({
    clientId: 'gh-id',
    clientSecret: 'gh-secret',
    redirectUri: 'https://app.example.com/auth/github/callback',
  })

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

    const tokenResponse = {
      access_token: 'token-123',
      token_type: 'bearer',
      scope: 'read:user',
    }
    const userResponse = {
      id: 42,
      email: 'octo@example.com',
      name: 'Octo Cat',
      avatar_url: 'https://example.com/avatar.png',
    }

    const fetchMock = mock(async (input: string) => {
      if (input.includes('/access_token')) {
        return new Response(JSON.stringify(tokenResponse), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify(userResponse), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    ;(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch

    const { state } = await manager.authorize('github')
    const profile = await manager.user('github', { code: 'auth-code', state })

    expect(profile.id).toBe('42')
    expect(profile.email).toBe('octo@example.com')
    expect(profile.token.accessToken).toBe('token-123')
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
