import { AuthenticationException } from '../../errors/exceptions/AuthenticationException'
import { buildTokenUrl, generateToken, hashToken, parseTokenUrl } from '../utils'

export interface OAuthProviderConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
  authorizeUrl: string
  tokenUrl: string
  userInfoUrl: string
  scopes?: string[]
  tokenAuthMethod?: 'client_secret_post' | 'client_secret_basic'
  userInfoMethod?: 'GET' | 'POST'
  mapProfile?: (raw: Record<string, unknown>, token: OAuthTokenResult) => OAuthUserProfile
}

export interface OAuthTokenResult {
  accessToken: string
  tokenType?: string
  refreshToken?: string
  expiresIn?: number
  scope?: string
  raw: Record<string, unknown>
}

export interface OAuthUserProfile {
  id: string
  email?: string
  name?: string
  avatar?: string
  token: OAuthTokenResult
  raw: Record<string, unknown>
}

export interface OAuthStatePayload {
  provider: string
  redirectTo?: string
  expiresAt: Date
}

export interface OAuthStateStore {
  store(stateHash: string, payload: OAuthStatePayload): Promise<void>
  find(stateHash: string): Promise<OAuthStatePayload | null>
  delete(stateHash: string): Promise<void>
}

export interface OAuthStateConfig {
  expiresIn?: number
  stateLength?: number
  hashAlgorithm?: 'sha256' | 'sha512'
  /**
   * External hosts allowed as `redirectTo` targets (supports `*.example.com`
   * wildcards). App-relative paths (`/dashboard`) are always allowed; anything
   * else is dropped to prevent open redirects.
   */
  allowedRedirectHosts?: string[]
}

export interface OAuthAuthorizeOptions {
  scope?: string[]
  redirectTo?: string
  state?: string
  extraParams?: Record<string, string>
}

export interface OAuthCallbackPayload {
  code: string
  state: string
}

export interface OAuthManagerOptions {
  stateStore?: OAuthStateStore
  stateConfig?: OAuthStateConfig
}

const DEFAULT_STATE_EXPIRES_IN = 10 * 60 * 1000
const DEFAULT_STATE_LENGTH = 24
const DEFAULT_STATE_HASH_ALGORITHM: NonNullable<OAuthStateConfig['hashAlgorithm']> = 'sha256'

export class MemoryOAuthStateStore implements OAuthStateStore {
  private readonly states = new Map<string, OAuthStatePayload>()
  private readonly maxEntries: number

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = options.maxEntries ?? 10_000
  }

  async store(stateHash: string, payload: OAuthStatePayload): Promise<void> {
    // Bound the store: unauthenticated requests to the authorize endpoint
    // each create one entry, so an unbounded map is a memory-exhaustion DoS.
    if (this.states.size >= this.maxEntries) {
      this.sweepExpired()
    }
    // Still full after sweeping — evict oldest entries (insertion order).
    while (this.states.size >= this.maxEntries) {
      const oldest = this.states.keys().next().value
      if (oldest === undefined) break
      this.states.delete(oldest)
    }

    this.states.set(stateHash, payload)
  }

  private sweepExpired(): void {
    const now = Date.now()
    for (const [hash, payload] of this.states) {
      if (payload.expiresAt.getTime() <= now) {
        this.states.delete(hash)
      }
    }
  }

  async find(stateHash: string): Promise<OAuthStatePayload | null> {
    const payload = this.states.get(stateHash)
    if (!payload) return null
    if (payload.expiresAt.getTime() <= Date.now()) {
      this.states.delete(stateHash)
      return null
    }
    return payload
  }

  async delete(stateHash: string): Promise<void> {
    this.states.delete(stateHash)
  }

  clear(): void {
    this.states.clear()
  }
}

export class OAuthManager {
  private readonly providers = new Map<string, OAuthProviderConfig>()
  private readonly stateStore: OAuthStateStore
  private readonly stateConfig: Required<OAuthStateConfig>

  constructor(options: OAuthManagerOptions = {}) {
    this.stateStore = options.stateStore ?? new MemoryOAuthStateStore()
    this.stateConfig = {
      expiresIn: options.stateConfig?.expiresIn ?? DEFAULT_STATE_EXPIRES_IN,
      stateLength: options.stateConfig?.stateLength ?? DEFAULT_STATE_LENGTH,
      hashAlgorithm: options.stateConfig?.hashAlgorithm ?? DEFAULT_STATE_HASH_ALGORITHM,
      allowedRedirectHosts: options.stateConfig?.allowedRedirectHosts ?? [],
    }
  }

  registerProvider(name: string, config: OAuthProviderConfig): void {
    this.providers.set(name, config)
  }

  providerNames(): string[] {
    return Array.from(this.providers.keys()).sort((a, b) => a.localeCompare(b))
  }

  getProvider(name: string): OAuthProviderConfig {
    const provider = this.providers.get(name)
    if (!provider) {
      throw new AuthenticationException(`OAuth provider "${name}" is not configured.`)
    }
    return provider
  }

  async authorize(providerName: string, options: OAuthAuthorizeOptions = {}): Promise<{ url: string; state: string; expiresAt: Date }> {
    const provider = this.getProvider(providerName)
    const { state, expiresAt } = await createOAuthState(
      providerName,
      this.stateStore,
      this.stateConfig,
      options.redirectTo,
      options.state,
    )
    const scope = options.scope ?? provider.scopes
    const url = buildOAuthAuthorizeUrl(provider, state, { scope, extraParams: options.extraParams })
    return { url, state, expiresAt }
  }

  async user(providerName: string, payload: OAuthCallbackPayload): Promise<OAuthUserProfile> {
    const { profile } = await this.handleCallback(providerName, payload)
    return profile
  }

  /**
   * Verify the callback and return the user profile together with the
   * sanitized `redirectTo` stored at authorize time. `redirectTo` is safe to
   * pass to a redirect response: app-relative paths and allowlisted hosts
   * only.
   */
  async handleCallback(
    providerName: string,
    payload: OAuthCallbackPayload,
  ): Promise<{ profile: OAuthUserProfile; redirectTo?: string }> {
    const provider = this.getProvider(providerName)
    const verified = await verifyOAuthState(payload.state, providerName, this.stateStore, this.stateConfig)
    if (!verified) {
      throw new AuthenticationException('Invalid or expired OAuth state.')
    }

    const token = await exchangeOAuthCode(provider, payload.code)
    const profile = await fetchOAuthUserProfile(provider, token)
    return { profile, redirectTo: verified.redirectTo }
  }
}

export function createOAuthManager(options: OAuthManagerOptions = {}): OAuthManager {
  return new OAuthManager(options)
}

export async function createOAuthState(
  provider: string,
  store: OAuthStateStore,
  config: OAuthStateConfig = {},
  redirectTo?: string,
  fixedState?: string,
): Promise<{ state: string; expiresAt: Date }> {
  const state = fixedState ?? generateToken(config.stateLength ?? DEFAULT_STATE_LENGTH)
  const hashAlgorithm = config.hashAlgorithm ?? DEFAULT_STATE_HASH_ALGORITHM
  const expiresAt = new Date(Date.now() + (config.expiresIn ?? DEFAULT_STATE_EXPIRES_IN))
  const stateHash = hashToken(state, hashAlgorithm)
  await store.store(stateHash, {
    provider,
    redirectTo: sanitizeOAuthRedirect(redirectTo, config.allowedRedirectHosts),
    expiresAt,
  })
  return { state, expiresAt }
}

export async function verifyOAuthState(
  state: string,
  provider: string,
  store: OAuthStateStore,
  config: OAuthStateConfig = {},
): Promise<OAuthStatePayload | null> {
  const hashAlgorithm = config.hashAlgorithm ?? DEFAULT_STATE_HASH_ALGORITHM
  const stateHash = hashToken(state, hashAlgorithm)
  const payload = await store.find(stateHash)
  if (!payload) return null
  await store.delete(stateHash)
  if (payload.provider !== provider) return null
  // Re-sanitize on the way out so custom stores and states persisted before
  // an allowlist change cannot smuggle an unsafe target through.
  return { ...payload, redirectTo: sanitizeOAuthRedirect(payload.redirectTo, config.allowedRedirectHosts) }
}

/**
 * Reduce a `redirectTo` value to a safe target: app-relative paths always
 * pass; absolute http(s) URLs pass only when their host is in the allowlist
 * (supports `*.example.com` wildcards). Everything else — protocol-relative
 * URLs, backslash tricks, `javascript:` and other schemes — returns
 * `undefined`.
 */
export function sanitizeOAuthRedirect(
  redirectTo: string | undefined,
  allowedHosts: string[] = [],
): string | undefined {
  const value = redirectTo?.trim()

  if (!value) {
    return undefined
  }

  // Normalize backslash tricks (e.g. /\evil.com) before classifying
  const normalized = value.replace(/\\/g, '/')

  if (normalized.startsWith('/') && !normalized.startsWith('//')) {
    return normalized
  }

  try {
    const target = new URL(normalized)

    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return undefined
    }

    for (const allowed of allowedHosts) {
      if (allowed.startsWith('*.')) {
        const suffix = allowed.slice(1).toLowerCase()
        if (target.hostname.toLowerCase().endsWith(suffix) && target.hostname.length > suffix.length) {
          return normalized
        }
      } else if (target.host.toLowerCase() === allowed.toLowerCase()) {
        return normalized
      }
    }
  } catch {
    return undefined
  }

  return undefined
}

export function buildOAuthAuthorizeUrl(
  provider: OAuthProviderConfig,
  state: string,
  options: { scope?: string[]; extraParams?: Record<string, string> } = {},
): string {
  const url = new URL(provider.authorizeUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', provider.clientId)
  url.searchParams.set('redirect_uri', provider.redirectUri)
  url.searchParams.set('state', state)

  const scopes = options.scope ?? provider.scopes
  if (scopes && scopes.length > 0) {
    url.searchParams.set('scope', scopes.join(' '))
  }

  for (const [key, value] of Object.entries(options.extraParams ?? {})) {
    url.searchParams.set(key, value)
  }

  return url.toString()
}

export async function exchangeOAuthCode(
  provider: OAuthProviderConfig,
  code: string,
): Promise<OAuthTokenResult> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: provider.redirectUri,
    client_id: provider.clientId,
  })

  const headers: HeadersInit = {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
  }

  if (provider.tokenAuthMethod === 'client_secret_basic') {
    const credentials = Buffer.from(`${provider.clientId}:${provider.clientSecret}`).toString('base64')
    headers.Authorization = `Basic ${credentials}`
  } else {
    params.set('client_secret', provider.clientSecret)
  }

  const response = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers,
    body: params.toString(),
  })

  if (!response.ok) {
    throw new AuthenticationException(`OAuth token exchange failed (${response.status}).`)
  }

  const raw = await response.json() as Record<string, unknown>
  const accessToken = typeof raw.access_token === 'string' ? raw.access_token : ''
  if (!accessToken) {
    throw new AuthenticationException('OAuth token exchange did not return an access token.')
  }

  return {
    accessToken,
    tokenType: typeof raw.token_type === 'string' ? raw.token_type : undefined,
    refreshToken: typeof raw.refresh_token === 'string' ? raw.refresh_token : undefined,
    expiresIn: typeof raw.expires_in === 'number' ? raw.expires_in : undefined,
    scope: typeof raw.scope === 'string' ? raw.scope : undefined,
    raw,
  }
}

export async function fetchOAuthUserProfile(
  provider: OAuthProviderConfig,
  token: OAuthTokenResult,
): Promise<OAuthUserProfile> {
  const response = await fetch(provider.userInfoUrl, {
    method: provider.userInfoMethod ?? 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token.accessToken}`,
      'User-Agent': 'guren-oauth',
    },
  })

  if (!response.ok) {
    throw new AuthenticationException(`OAuth user fetch failed (${response.status}).`)
  }

  const raw = await response.json() as Record<string, unknown>
  if (provider.mapProfile) {
    return provider.mapProfile(raw, token)
  }

  const idCandidate = raw.id ?? raw.sub
  const id = typeof idCandidate === 'string' || typeof idCandidate === 'number'
    ? String(idCandidate)
    : ''
  if (!id) {
    throw new AuthenticationException('OAuth user profile is missing an identifier.')
  }

  return {
    id,
    email: typeof raw.email === 'string' ? raw.email : undefined,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    avatar:
      typeof raw.avatar_url === 'string' ? raw.avatar_url
        : typeof raw.picture === 'string' ? raw.picture
          : typeof raw.avatar === 'string' ? raw.avatar
            : undefined,
    token,
    raw,
  }
}

export interface OAuthProviderFactoryInput {
  clientId: string
  clientSecret: string
  redirectUri: string
  scopes?: string[]
}

export function createGitHubOAuthProviderConfig(input: OAuthProviderFactoryInput): OAuthProviderConfig {
  return {
    ...input,
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userInfoUrl: 'https://api.github.com/user',
    scopes: input.scopes ?? ['read:user', 'user:email'],
  }
}

export function createGoogleOAuthProviderConfig(input: OAuthProviderFactoryInput): OAuthProviderConfig {
  return {
    ...input,
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scopes: input.scopes ?? ['openid', 'profile', 'email'],
  }
}

export function createDiscordOAuthProviderConfig(input: OAuthProviderFactoryInput): OAuthProviderConfig {
  return {
    ...input,
    authorizeUrl: 'https://discord.com/api/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    userInfoUrl: 'https://discord.com/api/users/@me',
    scopes: input.scopes ?? ['identify', 'email'],
  }
}

export function buildOAuthRedirectUrl(baseUrl: string, token: string, email?: string): string {
  return buildTokenUrl(baseUrl, token, email)
}

export function parseOAuthRedirectUrl(url: string): { token: string | null; email: string | null } {
  return parseTokenUrl(url)
}
