import type { Context } from 'hono'
import type { Session } from '../http/middleware'
import type { AuthContext, AuthCredentials, Guard } from './types'

export type GuardResolver = (name?: string) => Guard<unknown>

export class RequestAuthContext implements AuthContext {
  private readonly guardCache = new Map<string, Guard<unknown>>()

  constructor(
    private readonly manager: { getDefaultGuard(): string },
    private readonly ctx: Context,
    private readonly currentSession: Session | undefined,
    private readonly resolveGuard: GuardResolver,
  ) {}

  guard<T = unknown>(name?: string): Guard<T> {
    const key = name ?? this.manager.getDefaultGuard()
    if (!this.guardCache.has(key)) {
      const guard = this.resolveGuard(name)
      this.guardCache.set(key, guard)
    }

    return this.guardCache.get(key) as Guard<T>
  }

  session<T extends Session = Session>(): T | undefined {
    return this.currentSession as T | undefined
  }

  async check(): Promise<boolean> {
    return this.guard().check()
  }

  async guest(): Promise<boolean> {
    return this.guard().guest()
  }

  async user<T = unknown>(): Promise<T | null> {
    return this.guard<T>().user()
  }

  async id(): Promise<unknown> {
    return this.guard().id()
  }

  async login<T = unknown>(user: T, remember?: boolean): Promise<void> {
    await this.guard<T>().login(user, remember)
  }

  async attempt(credentials: AuthCredentials, remember?: boolean): Promise<boolean> {
    return this.guard().attempt(credentials, remember)
  }

  async logout(): Promise<void> {
    await this.guard().logout()
  }
}
