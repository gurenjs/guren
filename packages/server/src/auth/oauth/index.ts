import { AuthenticationException } from '../../errors/exceptions/AuthenticationException'
import {
  hostMatchesAllowlist,
  isAppRelativePath,
  normalizeRedirectTarget,
} from '../../support/redirect-target'
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
  /**
   * Key in the userinfo response carrying the provider's own verification
   * signal for the email address — Discord returns `verified`, for example.
   * Defaults to OIDC's standard `email_verified` claim. Only boolean values
   * are read; anything else leaves `profile.emailVerified` undefined. Ignored
   * when `mapProfile` is set, since that owns the whole mapping.
   */
  emailVerifiedKey?: string
  /**
   * Fallback used when the userinfo response carries no email — e.g. GitHub
   * returns `email: null` for accounts with a private email even when the
   * `user:email` scope was granted. Returns the email to use, or undefined
   * to leave the profile without one.
   *
   * Only return an address the provider has verified: the resulting profile
   * reports `emailVerified: true`, since the returned address is a different
   * one than `emailVerifiedKey` was read against.
   */
  fetchFallbackEmail?: (token: OAuthTokenResult) => Promise<string | undefined>
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
  /**
   * Whether the provider itself verified `email`. Tri-state on purpose:
   * `true` — the provider asserts the address is verified; `false` — it
   * asserts it is not; `undefined` — the provider sends no such signal
   * (GitHub's `/user`, for instance), so the consumer decides its own policy.
   * Returning an email is not by itself a claim that it was checked, so
   * treating `undefined` as verified is a decision, not a default.
   */
  emailVerified?: boolean
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
  /**
   * Atomically fetch and delete a state in one step. Exactly one caller may
   * receive the payload; every other concurrent caller (and any later call)
   * must get null. Expired states must also return null, mirroring `find`.
   *
   * Optional for backward compatibility: `verifyOAuthState` prefers this
   * when present. Stores that only implement find/delete keep working, but
   * leave a window where two concurrent callbacks with the same state can
   * both pass verification.
   */
  consume?(stateHash: string): Promise<OAuthStatePayload | null>
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

  async consume(stateHash: string): Promise<OAuthStatePayload | null> {
    // Map.get + Map.delete run synchronously before the first await, so
    // within one isolate at most one caller can observe the entry.
    const payload = this.states.get(stateHash)
    if (!payload) return null
    this.states.delete(stateHash)
    if (payload.expiresAt.getTime() <= Date.now()) return null
    return payload
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
  const payload = typeof store.consume === 'function'
    ? await store.consume(stateHash)
    : await findAndDeleteState(store, stateHash)
  if (!payload) return null
  if (payload.provider !== provider) return null
  // Re-sanitize on the way out so custom stores and states persisted before
  // an allowlist change cannot smuggle an unsafe target through.
  return { ...payload, redirectTo: sanitizeOAuthRedirect(payload.redirectTo, config.allowedRedirectHosts) }
}

// Fallback for stores without consume(): two concurrent callbacks can both
// find() before either delete() lands, so one-time use is not strict here.
async function findAndDeleteState(
  store: OAuthStateStore,
  stateHash: string,
): Promise<OAuthStatePayload | null> {
  const payload = await store.find(stateHash)
  if (!payload) return null
  await store.delete(stateHash)
  return payload
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

  const normalized = normalizeRedirectTarget(value)

  if (isAppRelativePath(normalized)) {
    return normalized
  }

  try {
    const target = new URL(normalized)

    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return undefined
    }

    return hostMatchesAllowlist(target, allowedHosts) ? normalized : undefined
  } catch {
    return undefined
  }
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
  const profile = provider.mapProfile
    ? provider.mapProfile(raw, token)
    : defaultProfileFromUserInfo(raw, token, provider.emailVerifiedKey)

  if (!profile.email && provider.fetchFallbackEmail) {
    const email = await provider.fetchFallbackEmail(token)
    if (email) {
      // A fallback address is a different one than the userinfo response was
      // read against, and the contract is that only verified addresses are
      // returned — so the signal read from `raw` no longer applies to it.
      return { ...profile, email, emailVerified: true }
    }
  }

  return profile
}

// OIDC's standard claim, so hand-configured OIDC providers get it without
// declaring anything. Provider-specific keys belong on the provider config.
const DEFAULT_EMAIL_VERIFIED_KEY = 'email_verified'

function readEmailVerified(
  raw: Record<string, unknown>,
  key: string = DEFAULT_EMAIL_VERIFIED_KEY,
): boolean | undefined {
  const value = raw[key]
  return typeof value === 'boolean' ? value : undefined
}

function defaultProfileFromUserInfo(
  raw: Record<string, unknown>,
  token: OAuthTokenResult,
  emailVerifiedKey?: string,
): OAuthUserProfile {
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
    emailVerified: readEmailVerified(raw, emailVerifiedKey),
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

// GitHub's /user endpoint returns `email: null` whenever the account's email
// is set to private, even with the `user:email` scope granted — the primary
// verified address is only available from this separate endpoint.
async function fetchGitHubPrimaryEmail(token: OAuthTokenResult): Promise<string | undefined> {
  const response = await fetch('https://api.github.com/user/emails', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token.accessToken}`,
      'User-Agent': 'guren-oauth',
    },
  })

  if (!response.ok) {
    return undefined
  }

  const emails = await response.json() as unknown
  if (!Array.isArray(emails)) {
    return undefined
  }

  const primary = emails.find(
    (entry): entry is { email: string } =>
      typeof entry === 'object' && entry !== null &&
      (entry as { primary?: unknown }).primary === true &&
      (entry as { verified?: unknown }).verified === true &&
      typeof (entry as { email?: unknown }).email === 'string',
  )
  return primary?.email
}

export function createGitHubOAuthProviderConfig(input: OAuthProviderFactoryInput): OAuthProviderConfig {
  return {
    ...input,
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userInfoUrl: 'https://api.github.com/user',
    scopes: input.scopes ?? ['read:user', 'user:email'],
    fetchFallbackEmail: fetchGitHubPrimaryEmail,
  }
}

export function createGoogleOAuthProviderConfig(input: OAuthProviderFactoryInput): OAuthProviderConfig {
  return {
    ...input,
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scopes: input.scopes ?? ['openid', 'profile', 'email'],
    emailVerifiedKey: 'email_verified',
  }
}

export function createDiscordOAuthProviderConfig(input: OAuthProviderFactoryInput): OAuthProviderConfig {
  return {
    ...input,
    authorizeUrl: 'https://discord.com/api/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    userInfoUrl: 'https://discord.com/api/users/@me',
    scopes: input.scopes ?? ['identify', 'email'],
    emailVerifiedKey: 'verified',
  }
}

export function buildOAuthRedirectUrl(baseUrl: string, token: string, email?: string): string {
  return buildTokenUrl(baseUrl, token, email)
}

export function parseOAuthRedirectUrl(url: string): { token: string | null; email: string | null } {
  return parseTokenUrl(url)
}
