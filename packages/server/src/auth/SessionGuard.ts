import type { Session } from '../http/middleware'
import type { AuthCredentials, Authenticatable, Guard, UserProvider } from './types'

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
    if (!providerToken || providerToken !== rememberToken) {
      this.currentSession.forget(this.rememberSessionKey())
      return null
    }

    this.cachedUser = user
    await this.provider.setRememberToken?.(user, rememberToken)
    return user
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

    this.cachedUser = user
    return user
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

    return session.get(this.sessionKey()) ?? null
  }

  private async remember(user: User): Promise<void> {
    if (!this.currentSession || !this.provider.setRememberToken) {
      return
    }

    const token = globalThis.crypto.randomUUID()
    await this.provider.setRememberToken?.(user, token)
    this.currentSession.set(this.rememberSessionKey(), token)
  }

  async login<T = User>(user: T, remember = false): Promise<void> {
    const castUser = user as unknown as User
    const session = this.currentSession
    if (!session) {
      throw new Error('SessionGuard: session middleware is required to use the session guard.')
    }

    const identifier = this.provider.getId(castUser)
    session.set(this.sessionKey(), identifier)
    this.cachedUser = castUser

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

    session.forget(this.sessionKey())
    session.forget(this.rememberSessionKey())
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
      return null
    }

    const valid = await this.provider.validateCredentials(user, credentials)
    if (!valid) {
      return null
    }

    return user
  }

  session<T extends Session = Session>(): T | undefined {
    return this.currentSession as T | undefined
  }
}
