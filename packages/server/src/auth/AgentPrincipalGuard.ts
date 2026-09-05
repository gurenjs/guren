import type { Session } from '../http/middleware'
import type { InstalledAgentPrincipal } from '../internal/agent-principal'
import { sanitizeUser } from './providers/UserProvider'
import type { AuthCredentials, Guard, UserProvider } from './types'

export interface AgentPrincipalGuardOptions<User = unknown> {
  /** The principal the invocation pipeline installed on this request. */
  installed: InstalledAgentPrincipal
  /**
   * Resolves a `kind: 'user'` principal's id to a full user record, the same
   * provider `useTokens({ provider })` names. Without one the guard still
   * authenticates: `user()` resolves to a minimal `{ id }` record so
   * Gate/policy evaluation (which keys on `id`) works out of the box — the
   * shape `TokenGuard` returns for a token with no provider configured.
   */
  provider?: UserProvider<User>
}

/**
 * The guard answering for a principal the pipeline installed (RFC 0017 §2), for
 * an **unqualified** lookup on a seam-marked request; explicit `guard('web')` /
 * `guard('token')` is untouched, and `guardNames()` never lists this one. It
 * satisfies `requireAuthenticated()`, `Controller.auth` and `Gate`, but not
 * `createBearerTokenMiddleware` / `tokenCan*`, which judge an `ApiToken`.
 */
export class AgentPrincipalGuard<User = unknown> implements Guard<User> {
  private readonly installed: InstalledAgentPrincipal
  private readonly provider?: UserProvider<User>
  private resolvedUser?: Promise<User | null>

  constructor(options: AgentPrincipalGuardOptions<User>) {
    this.installed = options.installed
    this.provider = options.provider
  }

  /**
   * `user() !== null`, the predicate `TokenGuard` answers `check()` with: true
   * in every case but one, a `kind: 'user'` principal a configured provider
   * cannot resolve. Answering true there would admit a request whose
   * `Controller.auth.userOrFail()` then throws.
   */
  async check(): Promise<boolean> {
    return (await this.user()) !== null
  }

  async guest(): Promise<boolean> {
    return !(await this.check())
  }

  /**
   * `kind: 'service'` is always the minimal `{ id }`: a service principal names
   * no user, so a lookup would resolve an id in a table it does not belong to.
   * `kind: 'user'` goes through the provider when one is configured.
   */
  user<T = User>(): Promise<T | null> {
    if (!this.resolvedUser) {
      this.resolvedUser = (async () => {
        const { principal } = this.installed
        if (principal.kind !== 'user' || !this.provider) {
          return { id: principal.id } as unknown as User
        }

        const record = await this.provider.retrieveById(principal.id)
        return record ? sanitizeUser(this.provider, record) : null
      })()
    }
    return this.resolvedUser as Promise<T | null>
  }

  async id(): Promise<unknown> {
    return this.installed.principal.id
  }

  async login(): Promise<void> {
    throw new Error(
      'The agent principal guard does not support login(); the principal is installed by the '
      + 'invocation pipeline for one request.',
    )
  }

  async attempt(_credentials: AuthCredentials, _remember?: boolean): Promise<boolean> {
    throw new Error(
      'The agent principal guard does not support attempt(); an installed principal is not '
      + 'credential-based.',
    )
  }

  async validate(_credentials: AuthCredentials): Promise<User | null> {
    throw new Error(
      'The agent principal guard does not support validate(); an installed principal is not '
      + 'credential-based.',
    )
  }

  /** Nothing to end: no session, and no stored credential to revoke. */
  async logout(): Promise<void> {}

  session<T extends Session = Session>(): T | undefined {
    return undefined
  }
}
