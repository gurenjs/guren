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
}

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
