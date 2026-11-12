import type { Session } from '../http/middleware'
import type { AuthCredentials, Authenticatable, Guard, UserProvider } from './types'
import { generateToken, secureStringCompare } from './utils'
import { sanitizeUser } from './providers/UserProvider'
import { redactQueryParams } from '../errors/redact-query-params'

export interface SessionGuardOptions {
  provider: UserProvider
  sessionKey?: string
  rememberSessionKey?: string
  session: Session | undefined
}

const DEFAULT_SESSION_KEY = 'auth:user_id'
const DEFAULT_REMEMBER_KEY = 'auth:remember_token'

export class SessionGuard<User extends Authenticatable = Authenticatable> implements Guard<User> {
  private cachedUser: User | null | undefined

  constructor(private readonly options: SessionGuardOptions) {}

  private get currentSession(): Session | undefined {
    return this.options.session
  }

  private get provider(): UserProvider<User> {
    return this.options.provider as UserProvider<User>
  }

  private sessionKey(): string {
    return this.options.sessionKey ?? DEFAULT_SESSION_KEY
  }

  private rememberSessionKey(): string {
    return this.options.rememberSessionKey ?? DEFAULT_REMEMBER_KEY
  }

  private async loadRememberedUser(): Promise<User | null> {
    if (!this.currentSession || !this.provider.getRememberToken) {
      return null
    }

    const rememberToken = this.currentSession.get<string>(this.rememberSessionKey())
    if (!rememberToken) {
      return null
    }

    const user = await this.provider.retrieveByCredentials({ rememberToken })
    if (!user) {
      this.currentSession.forget(this.rememberSessionKey())
      return null
    }

    const providerToken = await this.provider.getRememberToken?.(user)
    if (!providerToken || !secureStringCompare(providerToken, rememberToken)) {
      this.currentSession.forget(this.rememberSessionKey())
      return null
    }

    if (!(await this.holdsCurrentCredential(this.currentSession, user))) {
      this.forgetLogin(this.currentSession)
      return null
    }

    await this.provider.setRememberToken?.(user, rememberToken)
    const sanitized = this.sanitizeUser(user)
    this.cachedUser = sanitized
    return sanitized
  }

  private sanitizeUser(user: User): User {
    return sanitizeUser(this.provider, user)
  }

  // Derived from the session key: guards given distinct keys on one session
  // keep distinct fingerprints.
  private fingerprintSessionKey(): string {
    return `${this.sessionKey()}:fingerprint`
  }

  /**
   * Whether the session was opened under the credential `user` holds now. A
   * session with no fingerprint fails for an account that has a credential:
   * nothing shows it was opened under the current one.
   */
  private async holdsCurrentCredential(session: Session, user: User): Promise<boolean> {
    const current = await this.provider.credentialFingerprint?.(user)
    const stored = session.get(this.fingerprintSessionKey())
    // No credential to compare (`null`, or a record without one) passes only
    // a session that was never bound: login() stores nothing for either.
    if (current == null) return stored == null
    return typeof stored === 'string' && secureStringCompare(stored, current)
  }

  private async bindCredential(session: Session, user: User, identifier: unknown): Promise<void> {
    const provider = this.provider
    if (!provider.credentialFingerprint) return

    let fingerprint = await provider.credentialFingerprint(user)
    if (fingerprint === undefined) {
      const stored = await provider.retrieveById(identifier)
      fingerprint = stored ? await provider.credentialFingerprint(stored) : undefined
    }

    if (typeof fingerprint === 'string') {
      session.set(this.fingerprintSessionKey(), fingerprint)
    } else {
      session.forget(this.fingerprintSessionKey())
    }
  }

  /**
   * validate() may rehash the password of the user this session belongs to
   * (a profile form confirming the current password). The session moves to the
   * new hash, or its own next request would read as a password change.
   */
  private async followRehash(user: User, before: string | null | undefined, owner: unknown): Promise<void> {
    const session = this.currentSession
    if (!session || typeof before !== 'string') return

    const after = await this.provider.credentialFingerprint?.(user)
    if (typeof after !== 'string' || after === before) return
    if (owner == null || owner !== this.provider.getId(user)) return

    const stored = session.get(this.fingerprintSessionKey())
    if (typeof stored === 'string' && secureStringCompare(stored, before)) {
      session.set(this.fingerprintSessionKey(), after)
    }
  }

  /**
   * Whose session this is. A remembered session carries no id key, and must be
   * resolved before a rehash: afterwards its fingerprint reads as stale.
   */
  private async sessionUserId(): Promise<unknown> {
    const identifier = this.currentSession?.get(this.sessionKey())
    if (identifier != null) return identifier

    const user = await this.resolveUser()
    return user ? this.provider.getId(user) : null
  }

  private forgetLogin(session: Session): void {
    session.forget(this.sessionKey())
    session.forget(this.rememberSessionKey())
    session.forget(this.fingerprintSessionKey())
  }

  private async resolveUser(): Promise<User | null> {
    if (this.cachedUser !== undefined) {
      return this.cachedUser
    }

    const session = this.currentSession
    if (!session) {
      this.cachedUser = null
      return null
    }

    const identifier = session.get(this.sessionKey())

    if (identifier == null) {
      const remembered = await this.loadRememberedUser()
      this.cachedUser = remembered
      return remembered
    }

    const user = await this.provider.retrieveById(identifier)
    if (!user) {
      session.forget(this.sessionKey())
      this.cachedUser = null
      return null
    }

    if (!(await this.holdsCurrentCredential(session, user))) {
      this.forgetLogin(session)
      this.cachedUser = null
      return null
    }

    const sanitized = this.sanitizeUser(user)
    this.cachedUser = sanitized
    return sanitized
  }

  async check(): Promise<boolean> {
    return (await this.resolveUser()) !== null
  }

  async guest(): Promise<boolean> {
    return !(await this.check())
  }

  async user<T = User>(): Promise<T | null> {
    const user = await this.resolveUser()
    return (user as unknown as T | null) ?? null
  }

  async id(): Promise<unknown> {
    const session = this.currentSession
    if (!session) {
      return null
    }

    // A bound session's id is only as good as its credential check.
    if (this.provider.credentialFingerprint && !(await this.resolveUser())) {
      return null
    }

    return session.get(this.sessionKey()) ?? null
  }

  private async remember(user: User): Promise<void> {
    if (!this.currentSession || !this.provider.setRememberToken) {
      return
    }

    const token = generateToken(32)
    await this.provider.setRememberToken?.(user, token)
    this.currentSession.set(this.rememberSessionKey(), token)
  }

  async login<T = User>(user: T, remember = false): Promise<void> {
    const castUser = user as unknown as User
    const session = this.currentSession
    if (!session) {
      throw new Error('SessionGuard: session middleware is required to use the session guard.')
    }

    // Rotate the session ID so a pre-authentication session cannot be fixated
    session.regenerate()

    const identifier = this.provider.getId(castUser)
    session.set(this.sessionKey(), identifier)
    await this.bindCredential(session, castUser, identifier)
    this.cachedUser = this.sanitizeUser(castUser)

    if (remember) {
      await this.remember(castUser)
    } else {
      session.forget(this.rememberSessionKey())
    }
  }

  async logout(): Promise<void> {
    const session = this.currentSession
    if (!session) {
      return
    }

    this.forgetLogin(session)
    this.cachedUser = null
  }

  async attempt(credentials: AuthCredentials, remember = false): Promise<boolean> {
    const user = await this.validate(credentials)
    if (!user) {
      return false
    }

    await this.login(user, remember)
    return true
  }

  async validate(credentials: AuthCredentials): Promise<User | null> {
    const user = await this.provider.retrieveByCredentials(credentials)
    if (!user) {
      // Constant-time delay to prevent timing attacks (don't call provider with fake user)
      await new Promise(resolve => setTimeout(resolve, 100))
      return null
    }

    const valid = await this.provider.validateCredentials(user, credentials)
    if (!valid) {
      return null
    }

    // The one moment the plaintext is in hand next to a stored hash the
    // configured hasher would not write (an Argon2id row under the scrypt
    // default, a testing-cost hash in production). Best effort: the credentials
    // were correct and the stored hash still verifies, so a failed write is a
    // stale row to fix later, never a refused login.
    const fingerprint = await this.provider.credentialFingerprint?.(user)
    const owner = typeof fingerprint === 'string' ? await this.sessionUserId() : null
    try {
      await this.provider.rehashPasswordIfRequired?.(user, credentials)
    } catch (error) {
      console.warn(`[guren] Rehashing the password for user ${this.describeUser(user)} failed; the login continues.`, redactQueryParams(error))
    }
    await this.followRehash(user, fingerprint, owner)
    return user
  }

  /** Never the plaintext or the hash: a warning is a log line, and both belong in neither. */
  private describeUser(user: User): string {
    try {
      return String(this.provider.getId(user))
    } catch {
      return 'unknown'
    }
  }

  session<T extends Session = Session>(): T | undefined {
    return this.currentSession as T | undefined
  }
}
