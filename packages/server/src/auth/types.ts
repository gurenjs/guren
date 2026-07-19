import type { Context } from 'hono'
import type { Session } from '../http/middleware'

export type AuthCredentials = Record<string, unknown>

export interface Authenticatable {
  getAuthIdentifier(): unknown
  getAuthPassword(): string | null | undefined
  getRememberToken?(): string | null | undefined
  setRememberToken?(token: string | null): void | Promise<void>
}

export interface Guard<User = Authenticatable> {
  check(): Promise<boolean>
  guest(): Promise<boolean>
  user<T = User>(): Promise<T | null>
  id(): Promise<unknown>
  login<T = User>(user: T, remember?: boolean): Promise<void>
  logout(): Promise<void>
  attempt(credentials: AuthCredentials, remember?: boolean): Promise<boolean>
  validate(credentials: AuthCredentials): Promise<User | null>
  session<T extends Session = Session>(): T | undefined
}

export interface UserProvider<User = Authenticatable> {
  retrieveById(identifier: unknown): Promise<User | null>
  retrieveByCredentials(credentials: AuthCredentials): Promise<User | null>
  validateCredentials(user: User, credentials: AuthCredentials): Promise<boolean>
  getId(user: User): unknown
  setRememberToken?(user: User, token: string | null): Promise<void> | void
  getRememberToken?(user: User): Promise<string | null> | string | null
  /**
   * Strip fields that must never leave the auth layer (password hashes,
   * remember tokens, model `hidden` fields) from a user record before it
   * is cached or handed to application code via guard.user().
   */
  sanitize?(user: User): User
}

/**
 * The conventional names for the credential columns that
 * `ModelUserProvider.sanitize()` strips: the password column (`password`
 * by default, commonly configured as `passwordHash`/`password_hash`) and
 * the remember-token column (`remember_token` by default, commonly
 * `rememberToken`).
 */
export type DefaultSanitizedKeys =
  | 'password'
  | 'passwordHash'
  | 'password_hash'
  | 'rememberToken'
  | 'remember_token'

/**
 * The shape of a user record after auth-layer sanitization — what
 * `auth.user()` returns at runtime when the provider's column names
 * follow the {@link DefaultSanitizedKeys} conventions. Removes those
 * conventional credential keys plus any extra keys passed as `Hidden`.
 *
 * The runtime strips exactly the *configured* password/remember-token
 * columns plus the model's `static hidden` — a static type cannot see
 * that configuration. If your columns use other names, or the model
 * hides additional fields, list them in `Hidden` explicitly. Only
 * meaningful for concrete record types (index-signature records like
 * `Record<string, string>` cannot have individual keys removed).
 *
 * @example
 * ```ts
 * const user = await this.auth.userOrFail<Sanitized<UserRecord>>()
 * user.passwordHash // compile error — stripped at runtime
 *
 * // With additional hidden fields or custom column names:
 * type SafeUser = Sanitized<UserRecord, 'twoFactorSecret' | 'credentialDigest'>
 * ```
 */
export type Sanitized<User, Hidden extends string = never> = User extends unknown
  ? Omit<User, Extract<keyof User, DefaultSanitizedKeys | Hidden>>
  : never

export interface GuardContext {
  ctx: Context
  session: Session | undefined
  manager: AuthManagerContract
}

export type GuardFactory<User = Authenticatable> = (context: GuardContext) => Guard<User>

export interface ProviderFactory<User = Authenticatable> {
  (manager: AuthManagerContract): UserProvider<User>
}

export interface AuthManagerOptions {
  defaultGuard?: string
}

export interface AttachContextOptions {
  guard?: string
}

export interface AuthContext<User = Authenticatable> {
  check(): Promise<boolean>
  guest(): Promise<boolean>
  user<T = User>(): Promise<T | null>
  userOrFail<T = User>(): Promise<T>
  id(): Promise<unknown>
  login<T = User>(user: T, remember?: boolean): Promise<void>
  attempt(credentials: AuthCredentials, remember?: boolean): Promise<boolean>
  logout(): Promise<void>
  guard<T = User>(name?: string): Guard<T>
  session<T extends Session = Session>(): T | undefined
}

export interface AuthManagerContract {
  registerGuard<User = Authenticatable>(name: string, factory: GuardFactory<User>): void
  registerProvider<User = Authenticatable>(name: string, factory: ProviderFactory<User>): void
  getProvider<User = Authenticatable>(name: string): UserProvider<User>
  createGuard<User = Authenticatable>(name: string, context: GuardContext): Guard<User>
  guardNames(): string[]
  setDefaultGuard(name: string): void
  getDefaultGuard(): string
  createAuthContext(ctx: Context, options?: AttachContextOptions): AuthContext
}
