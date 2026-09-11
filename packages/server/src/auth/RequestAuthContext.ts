import type { Context } from 'hono'
import type { Session } from '../http/middleware'
import type { AuthContext, AuthCredentials, Guard } from './types'
import { setResolvedPrincipal, type ResolvedPrincipal } from './context'
import { AuthenticationException } from '../errors/exceptions/AuthenticationException'

export type GuardResolver = (resolvedName: string) => Guard<unknown>

export type PrincipalResolver = () => ResolvedPrincipal | undefined

export class RequestAuthContext implements AuthContext {
  private readonly guardCache = new Map<string, Guard<unknown>>()

  constructor(
    private readonly resolveName: (name?: string) => string,
    private readonly ctx: Context,
    private readonly resolveSession: () => Session | undefined,
    private readonly resolveGuard: GuardResolver,
    private readonly resolvePrincipal: PrincipalResolver = () => undefined,
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
    const principal = this.resolvePrincipal()
    if (principal) return principal.user != null
    return this.guard().check()
  }

  async guest(): Promise<boolean> {
    const principal = this.resolvePrincipal()
    if (principal) return principal.user == null
    return this.guard().guest()
  }

  async user<T = unknown>(): Promise<T | null> {
    const principal = this.resolvePrincipal()
    if (principal) return (principal.user ?? null) as T | null
    return this.guard<T>().user()
  }

  async userOrFail<T = unknown>(): Promise<T> {
    const u = await this.user<T>()
    if (!u) throw new AuthenticationException()
    return u
  }

  async id(): Promise<unknown> {
    const principal = this.resolvePrincipal()
    if (principal) return principal.user == null ? null : principal.id
    return this.guard().id()
  }

  async login<T = unknown>(user: T, remember?: boolean): Promise<void> {
    await this.guard<T>().login(user, remember)
    this.forgetPrincipal()
  }

  async attempt(credentials: AuthCredentials, remember?: boolean): Promise<boolean> {
    const succeeded = await this.guard().attempt(credentials, remember)
    if (succeeded) this.forgetPrincipal()
    return succeeded
  }

  async logout(): Promise<void> {
    const principal = this.resolvePrincipal()
    if (principal) {
      // Revoking only the presented credential, and leaving a co-present
      // session alone, is `TokenGuard.logout`'s rule.
      await principal.revoke?.()
      this.forgetPrincipal()
      return
    }
    await this.guard().logout()
  }

  /**
   * The request's identity is whatever just logged in, so a principal a
   * middleware resolved stops answering. A later `logout()` therefore ends the
   * new session rather than revoking the credential the request arrived with.
   */
  private forgetPrincipal(): void {
    setResolvedPrincipal(this.ctx, undefined)
  }
}
