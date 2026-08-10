import { AuthenticationException } from '../../errors/exceptions/AuthenticationException'
import {
  hostMatchesAllowlist,
  isAppRelativePath,
  normalizeRedirectTarget,
} from '../../support/redirect-target'
import { buildTokenUrl, generateToken, hashToken, parseTokenUrl, secureCompare } from '../utils'
import { isExpired } from '../../support/expiry'

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
   * The signal read via `emailVerifiedKey` does not carry over to a fallback
   * address — it was read against a response that had no email. A bare string
   * therefore makes no verification claim and leaves `profile.emailVerified`
   * undefined; return `{ email, emailVerified: true }` to assert one.
   */
  fetchFallbackEmail?: (token: OAuthTokenResult) => Promise<string | OAuthFallbackEmail | undefined>
}

export interface OAuthFallbackEmail {
  email: string
  /**
   * Whether the provider verified this specific address. Omit it when the
   * lookup cannot tell — the profile then reports `emailVerified: undefined`
   * rather than an unfounded claim.
   */
  emailVerified?: boolean
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
  /**
   * Hash of the value tying this state to the browser that started the flow.
   *
   * Without it `state` is unguessable and single-use but *transferable*: an
   * attacker can start a flow, capture their own `code`, and walk a victim's
   * browser through the callback, logging the victim into the attacker's
   * account. RFC 6749 §10.12 requires the binding; storing only the provider
   * name does not provide it.
   */
  binding?: string
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

/**
 * The slice of a session the manager needs to bind an OAuth flow to a
 * browser. The framework `Session` satisfies it structurally, so controllers
 * pass `this.auth.session()` straight through; anything else with these three
 * methods (a cookie jar wrapper, a test double) works too.
 */
export interface OAuthBindingSession {
  get<T = unknown>(key: string): T | undefined
  set<T = unknown>(key: string, value: T): void
  forget(key: string): void
}

/** Session key holding the per-browser bindings between authorize and callback. */
export const OAUTH_SESSION_BINDING_KEY = 'guren:oauth.bindings'

/**
 * How many unfinished flows one browser may have bindings for.
 *
 * Every `authorize()` parks one entry, and an abandoned flow leaves it behind
 * until it expires, so the list is capped. Beyond the cap the oldest entry is
 * dropped — that flow's callback then fails, which is the same outcome it had
 * before any of this existed.
 */
const MAX_PENDING_SESSION_BINDINGS = 5

export interface OAuthAuthorizeOptions {
  scope?: string[]
  redirectTo?: string
  state?: string
  extraParams?: Record<string, string>
  /**
   * Session of the browser starting the flow — pass `this.auth.session()`.
   *
   * The manager mints a per-browser binding, keeps it in the session, and
   * hashes it into the state; `handleCallback({ session })` presents it back.
   * Writing to the session is also what makes a visitor's brand-new session
   * persist across the provider round trip. `undefined` (no session
   * middleware, or none established yet) leaves the state unbound — the flow
   * still works, and `authorize()` warns once about the exposure.
   */
  session?: OAuthBindingSession
  /**
   * Bind the flow to the browser that started it, keeping the value yourself.
   *
   * Prefer `session` — it does the storing and consuming for you. Use this
   * when the binding lives somewhere else (an encrypted cookie, a test): pass
   * a value only this browser can present back. Only its hash reaches the
   * state store, and `handleCallback()` then requires the same value. Takes
   * precedence over `session` when both are given.
   */
  bindTo?: string
}

export interface OAuthCallbackPayload {
  code: string
  state: string
  /**
   * The same session handed to `authorize({ session })`. The binding is read
   * from it and removed in one step, so a replayed callback finds nothing.
   */
  session?: OAuthBindingSession
  /**
   * The value handed to `authorize({ bindTo })`, read back from wherever the
   * app kept it. Required when the state was created with a binding. Takes
   * precedence over `session` when both are given.
   */
  bindTo?: string
}

export interface OAuthManagerOptions {
  stateStore?: OAuthStateStore
  stateConfig?: OAuthStateConfig
}

let warnedAboutUnboundState = false

/**
 * An unbound `state` is transferable between browsers, which is exactly the
 * attack `state` exists to stop. Verification stays permissive so apps written
 * against the previous API keep working, so this is the only thing that tells
 * them they are exposed.
 */
function warnOnceAboutUnboundState(): void {
  if (warnedAboutUnboundState) return
  warnedAboutUnboundState = true
  console.warn(
    '[guren] OAuth authorize() was called without `session` or `bindTo`, so `state` is not tied '
    + 'to the browser that started the flow. An attacker can then complete their own authorization '
    + "in a victim's browser and log the victim into the attacker's account. Pass the current "
    + 'session (`this.auth.session()`) as `session` to both authorize() and handleCallback(), or '
    + 'manage a per-browser value yourself via `bindTo`. See: https://guren.dev/docs/guides/oauth',
  )
}

let warnedAboutDroppedBinding = false

/**
 * The flow was bound at authorize time but the state came back without one,
 * so the configured `OAuthStateStore` is not persisting `binding` — which
 * silently reverts the protection to the transferable state it replaced.
 */
function warnOnceAboutDroppedBinding(): void {
  if (warnedAboutDroppedBinding) return
  warnedAboutDroppedBinding = true
  console.warn(
    '[guren] An OAuth state was created with `bindTo` but came back from the state store '
    + 'without its binding, so the callback could not be tied to the browser that started the '
    + 'flow. The configured OAuthStateStore is dropping `OAuthStatePayload.binding` — for '
    + 'DatabaseOAuthStateStore this usually means the `oauth_states` table has no `binding` '
    + 'column. See: https://guren.dev/docs/guides/oauth',
  )
}

/**
 * Mint a fresh binding and park it in the session for the callback. A new
 * value per flow (rather than the session id) keeps session identifiers out
 * of the state store's inputs entirely and survives a login-triggered
 * session-id rotation happening mid-flow.
 */
interface PendingSessionBinding {
  /** Hash of the `state` this binding belongs to. */
  stateHash: string
  binding: string
  expiresAt: number
}

function readPendingBindings(session: OAuthBindingSession): PendingSessionBinding[] {
  const stored = session.get<unknown>(OAUTH_SESSION_BINDING_KEY)
  if (!Array.isArray(stored)) return []

  const now = Date.now()
  return stored.filter((entry): entry is PendingSessionBinding =>
    typeof entry === 'object'
    && entry !== null
    && typeof (entry as PendingSessionBinding).stateHash === 'string'
    && typeof (entry as PendingSessionBinding).binding === 'string'
    && typeof (entry as PendingSessionBinding).expiresAt === 'number'
    && (entry as PendingSessionBinding).expiresAt > now,
  )
}

function issueSessionBinding(session: OAuthBindingSession | undefined): string | undefined {
  if (!session) return undefined
  return generateToken(DEFAULT_STATE_LENGTH)
}

/**
 * Park a minted binding against the state it belongs to.
 *
 * Keyed by state rather than kept in one slot, so a browser can have several
 * flows in flight — two tabs, or a visitor who picks a different provider —
 * without each `authorize()` invalidating the one before it.
 */
function rememberSessionBinding(
  session: OAuthBindingSession,
  stateHash: string,
  binding: string,
  expiresAt: Date,
): void {
  const pending = readPendingBindings(session)
  pending.push({ stateHash, binding, expiresAt: expiresAt.getTime() })
  session.set(
    OAUTH_SESSION_BINDING_KEY,
    pending.slice(Math.max(0, pending.length - MAX_PENDING_SESSION_BINDINGS)),
  )
}

/**
 * Take the binding belonging to this callback's state, leaving the rest.
 *
 * Only the matching entry is removed: a forged callback carrying an unknown
 * state must not be able to strip a real flow's binding and lock the visitor
 * out of the login they actually started.
 */
function consumeSessionBinding(
  session: OAuthBindingSession | undefined,
  stateHash: string,
): string | undefined {
  if (!session) return undefined

  const pending = readPendingBindings(session)
  if (pending.length === 0) return undefined

  const match = pending.find((entry) => entry.stateHash === stateHash)
  // Written back either way, so expired entries are pruned on the way past.
  session.set(OAUTH_SESSION_BINDING_KEY, pending.filter((entry) => entry.stateHash !== stateHash))
  return match?.binding
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
      if (isExpired(payload.expiresAt, now)) {
        this.states.delete(hash)
      }
    }
  }

  async find(stateHash: string): Promise<OAuthStatePayload | null> {
    const payload = this.states.get(stateHash)
    if (!payload) return null
    if (isExpired(payload.expiresAt)) {
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
    if (isExpired(payload.expiresAt)) return null
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
    // `bindTo` wins, and then the session is not touched at all — the caller
    // is keeping the value themselves.
    const sessionBinding = options.bindTo ? undefined : issueSessionBinding(options.session)
    const bindTo = options.bindTo ?? sessionBinding
    if (!bindTo) {
      warnOnceAboutUnboundState()
    }

    const { state, expiresAt } = await createOAuthState(
      providerName,
      this.stateStore,
      this.stateConfig,
      options.redirectTo,
      options.state,
      bindTo,
    )

    // Parked only once the state exists, so it can be filed under it — and
    // only once the store accepted the state, so a failed authorize leaves
    // nothing behind.
    if (sessionBinding && options.session) {
      rememberSessionBinding(
        options.session,
        hashToken(state, this.stateConfig.hashAlgorithm),
        sessionBinding,
        expiresAt,
      )
    }
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
    const verified = await verifyOAuthState(
      payload.state,
      providerName,
      this.stateStore,
      this.stateConfig,
      payload.bindTo
        ?? consumeSessionBinding(
          payload.session,
          hashToken(payload.state, this.stateConfig.hashAlgorithm),
        ),
    )
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
  bindTo?: string,
): Promise<{ state: string; expiresAt: Date }> {
  const state = fixedState ?? generateToken(config.stateLength ?? DEFAULT_STATE_LENGTH)
  const hashAlgorithm = config.hashAlgorithm ?? DEFAULT_STATE_HASH_ALGORITHM
  const expiresAt = new Date(Date.now() + (config.expiresIn ?? DEFAULT_STATE_EXPIRES_IN))
  const stateHash = hashToken(state, hashAlgorithm)
  await store.store(stateHash, {
    provider,
    redirectTo: sanitizeOAuthRedirect(redirectTo, config.allowedRedirectHosts),
    expiresAt,
    // Only the hash is stored, so a leaked state store does not hand out
    // session ids.
    binding: bindTo ? hashToken(bindTo, hashAlgorithm) : undefined,
  })
  return { state, expiresAt }
}

export async function verifyOAuthState(
  state: string,
  provider: string,
  store: OAuthStateStore,
  config: OAuthStateConfig = {},
  bindTo?: string,
): Promise<OAuthStatePayload | null> {
  const hashAlgorithm = config.hashAlgorithm ?? DEFAULT_STATE_HASH_ALGORITHM
  const stateHash = hashToken(state, hashAlgorithm)
  const payload = typeof store.consume === 'function'
    ? await store.consume(stateHash)
    : await findAndDeleteState(store, stateHash)
  if (!payload) return null
  if (payload.provider !== provider) return null
  if (!bindingMatches(payload.binding, bindTo, hashAlgorithm)) return null
  // Re-sanitize on the way out so custom stores and states persisted before
  // an allowlist change cannot smuggle an unsafe target through.
  return { ...payload, redirectTo: sanitizeOAuthRedirect(payload.redirectTo, config.allowedRedirectHosts) }
}

/**
 * Whether the presented value matches the binding recorded at authorize time.
 *
 * A state created without a binding still verifies, so an app that has not
 * adopted `bindTo` keeps working. A state created *with* one is useless to a
 * browser that cannot present it, which is the whole point — so a missing or
 * wrong value fails.
 */
function bindingMatches(
  stored: string | undefined,
  presented: string | undefined,
  hashAlgorithm: 'sha256' | 'sha512',
): boolean {
  if (!stored) {
    // The caller bound this flow, so a payload coming back without one means
    // the store dropped the field rather than that the state was never bound.
    // Verification cannot tell the two apart, so it stays permissive — but a
    // store that silently discards the binding turns the protection off, and
    // nothing else would say so.
    if (presented) warnOnceAboutDroppedBinding()
    return true
  }
  if (!presented) return false
  // Both sides are hex digests, so this takes the hex-decoding comparator —
  // the same one the API-token store uses for stored-hash checks.
  return secureCompare(stored, hashToken(presented, hashAlgorithm))
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
    const fallback = await provider.fetchFallbackEmail(token)
    const email = typeof fallback === 'string' ? fallback : fallback?.email
    if (email) {
      // The signal read from `raw` was read against a response with no email,
      // so it cannot vouch for this one. Only the object form claims anything;
      // a bare string — every implementation written against the original
      // signature — leaves the field undefined rather than asserting `true`.
      const emailVerified = typeof fallback === 'string' ? undefined : fallback?.emailVerified
      return { ...profile, email, emailVerified }
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
async function fetchGitHubPrimaryEmail(token: OAuthTokenResult): Promise<OAuthFallbackEmail | undefined> {
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
  // The `verified === true` filter above is GitHub's own signal for this
  // address, so this lookup can claim what a generic fallback cannot.
  return primary ? { email: primary.email, emailVerified: true } : undefined
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
