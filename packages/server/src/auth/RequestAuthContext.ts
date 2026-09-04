import type { Context } from 'hono'
import type { Session } from '../http/middleware'
import type { AuthContext, AuthCredentials, Guard } from './types'
import { AuthenticationException } from '../errors/exceptions/AuthenticationException'

export type GuardResolver = (resolvedName: string) => Guard<unknown>

export class RequestAuthContext implements AuthContext {
  private readonly guardCache = new Map<string, Guard<unknown>>()

  constructor(
    private readonly resolveName: (name?: string) => string,
    private readonly ctx: Context,
    private readonly resolveSession: () => Session | undefined,
    private readonly resolveGuard: GuardResolver,
  ) {}

  guard<T = unknown>(name?: string): Guard<T> {
    // The cache key is the *effective* guard name, not the requested one: with
    // header-based selection an unqualified guard() may resolve to the token
    // guard, and caching that under the default guard's name would hand it to
    // an explicit guard('web') call later in the same request. The resolved key
    // is also what resolveGuard receives, so selection runs once per lookup.
    const key = this.resolveName(name)
    if (!this.guardCache.has(key)) {
      this.guardCache.set(key, this.resolveGuard(key))
    }

    return this.guardCache.get(key) as Guard<T>
  }

  session<T extends Session = Session>(): T | undefined {
    return this.resolveSession() as T | undefined
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

  async userOrFail<T = unknown>(): Promise<T> {
    const u = await this.user<T>()
    if (!u) throw new AuthenticationException()
    return u
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
