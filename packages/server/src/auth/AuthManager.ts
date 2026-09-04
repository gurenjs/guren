import type { Context } from 'hono'
import type { Model, PlainObject } from '@guren/orm'
import { getSessionFromContext } from '../http/middleware/session'
import { RequestAuthContext } from './RequestAuthContext'
import { ModelUserProvider, type ModelUserProviderOptions } from './providers/ModelUserProvider'
import { SessionGuard } from './SessionGuard'
import { TokenGuard } from './TokenGuard'
import { hasBearerHeader, type ApiTokenStore } from './api-token'
import { DefaultHasher } from './password/DefaultHasher'
import type {
  AttachContextOptions,
  AuthContext,
  AuthManagerContract,
  AuthManagerOptions,
  AuthCredentials,
  Guard,
  GuardContext,
  GuardFactory,
  ProviderFactory,
  UserProvider,
} from './types'

const DEFAULT_GUARD = 'web'

/** How `useTokens()` configures the guard it registers. */
export interface ApiTokenGuardOptions {
  /** Registered provider name that loads the full user record from a token's userId. */
  provider?: string
  /** Guard registry name (defaults to 'token'). */
  guardName?: string
  /** Whether verifying a bearer writes the token's `lastUsedAt`. */
  updateLastUsed?: boolean
}

interface GuardRegistryEntry {
  factory: GuardFactory<unknown>
}

interface ProviderRegistryEntry<User = unknown> {
  factory: ProviderFactory<User>
  instance?: UserProvider<User>
}

export class AuthManager implements AuthManagerContract {
  private readonly guards = new Map<string, GuardRegistryEntry>()
  private readonly providers = new Map<string, ProviderRegistryEntry<any>>()
  private defaultGuard: string
  private tokenGuard: string | null = null
  private apiTokenStore: ApiTokenStore | null = null
  private apiTokenOptions: ApiTokenGuardOptions = {}

  constructor(options: AuthManagerOptions = {}) {
    this.defaultGuard = options.defaultGuard ?? DEFAULT_GUARD
  }

  registerGuard<User>(name: string, factory: GuardFactory<User>): void {
    this.guards.set(name, { factory: factory as GuardFactory<unknown> })
  }

  registerProvider<User>(name: string, factory: ProviderFactory<User>): void {
    this.providers.set(name, { factory: factory as ProviderFactory<any> })
  }

  getProvider<User>(name: string): UserProvider<User> {
    const entry = this.providers.get(name)

    if (!entry) {
      throw new Error(`AuthManager: provider "${name}" has not been registered.`)
    }

    if (!entry.instance) {
      const instance = entry.factory(this)
      entry.instance = instance as UserProvider<any>
      this.providers.set(name, entry)
    }

    return entry.instance as UserProvider<User>
  }

  createGuard<User>(name: string, context: GuardContext): Guard<User> {
    const entry = this.guards.get(name)

    if (!entry) {
      throw new Error(`AuthManager: guard "${name}" has not been registered.`)
    }

    return entry.factory(context) as Guard<User>
  }

  guardNames(): string[] {
    return Array.from(this.guards.keys())
  }

  setDefaultGuard(name: string): void {
    if (!this.guards.has(name)) {
      throw new Error(`AuthManager: cannot set default guard to unregistered guard "${name}".`)
    }

    this.defaultGuard = name
  }

  getDefaultGuard(): string {
    return this.defaultGuard
  }

  /**
   * The guard name an unqualified `auth.guard()` / `auth.user()` call resolves
   * to for this request. Explicit names always win; otherwise a registered
   * token guard is selected when the request carries a Bearer Authorization
   * header, falling back to the default (session) guard — the composite-guard
   * rule from RFC 0016.
   */
  resolveGuardName(ctx: Context, name?: string): string {
    if (name) return name
    if (this.tokenGuard && hasBearerHeader(ctx)) return this.tokenGuard
    return this.defaultGuard
  }

  createAuthContext(ctx: Context, options: AttachContextOptions = {}): AuthContext {
    // Resolve the session lazily (at first guard use, not at attach time) so
    // the auth context can be attached anywhere in the middleware chain —
    // including before the session middleware — as long as the session
    // middleware has run by the time an auth method is actually called.
    const resolveSession = () => getSessionFromContext(ctx)

    const resolveName = (name?: string) => this.resolveGuardName(ctx, name ?? options.guard)

    // Receives the already-resolved name from RequestAuthContext (which
    // resolved it for the cache key), so selection runs once per lookup.
    const guardFactory = (resolvedName: string) => {
      return this.createGuard(resolvedName, {
        ctx,
        session: resolveSession(),
        manager: this,
      })
    }

    return new RequestAuthContext(resolveName, ctx, resolveSession, guardFactory)
  }

  async attempt(name: string, ctx: Context, credentials: AuthCredentials, remember?: boolean): Promise<boolean> {
    const guard = this.createAuthContext(ctx, { guard: name }).guard(name)
    return guard.attempt(credentials, remember)
  }

  /**
   * Register a model-based authentication provider and session guard — the
   * common case of authenticating users via a database model.
   *
   * @param providerName - Defaults to 'users'
   * @param guardName - Defaults to 'web'
   */
  useModel(
    model: typeof Model<PlainObject>,
    options: Partial<ModelUserProviderOptions> = {},
    providerName = 'users',
    guardName = 'web',
  ): void {
    // Credential columns are not defaulted here: ModelUserProvider reads
    // them from the model contract (resolvePasswordHashField /
    // resolveRememberTokenField) so a renamed column needs no repeating.
    const defaultOptions: ModelUserProviderOptions = {
      usernameColumn: 'email',
      credentialsPasswordField: 'password',
      hasher: new DefaultHasher(),
      ...options,
    }

    this.registerProvider(providerName, () => new ModelUserProvider(model, defaultOptions))

    this.registerGuard(guardName, ({ session, manager }) => {
      const provider = manager.getProvider(providerName)
      return new SessionGuard({ provider, session })
    })

    this.setDefaultGuard(guardName)
  }

  /**
   * Register a bearer-token guard backed by an ApiTokenStore and enable
   * header-based guard selection: requests carrying `Authorization: Bearer`
   * resolve to this guard, everything else keeps the default (session) guard.
   * Without `options.provider`, `auth.user()` resolves to a minimal `{ id }`
   * record (enough for Gate/policy evaluation).
   */
  useTokens(
    store: ApiTokenStore,
    options: ApiTokenGuardOptions = {},
  ): void {
    const guardName = options.guardName ?? 'token'

    // Refuse to shadow an existing guard: silently replacing the default
    // (session) guard would route Bearer-less requests through the token guard.
    // Re-calling useTokens with the same name stays legal (re-configuration).
    if (this.guards.has(guardName) && this.tokenGuard !== guardName) {
      throw new Error(
        `AuthManager: guard "${guardName}" is already registered. ` +
          'Pass a different guardName to useTokens() instead of shadowing it.',
      )
    }

    this.registerGuard(guardName, ({ ctx, manager }) => {
      const provider = options.provider ? manager.getProvider(options.provider) : undefined
      return new TokenGuard({
        store,
        ctx,
        provider,
        updateLastUsed: options.updateLastUsed,
      })
    })

    this.tokenGuard = guardName
    // Recorded last, after the shadowing guard above can throw: a refused
    // call must not leave a store behind for an issuer to find. A legal
    // re-call replaces it, matching the guard it just re-registered.
    this.apiTokenStore = store
    this.apiTokenOptions = { ...options }
  }

  /**
   * The options the last `useTokens()` call configured its guard with. Read by
   * machinery that has to *replace* the store without changing anything else —
   * `guren tool:dev` installs an ephemeral store, and a bare `useTokens(store)`
   * silently dropped the app's `provider`, so a token resolved to a bare
   * `{ id }` and every policy reading a user field behaved differently.
   */
  getApiTokenOptions(): ApiTokenGuardOptions {
    return { ...this.apiTokenOptions }
  }

  /**
   * The token store {@link useTokens} was configured with, or `undefined`. The
   * one path by which out-of-request machinery (`guren token:issue`, the App MCP
   * adapter's principal lookup) reaches the store the guard verifies against —
   * otherwise `store` is closed over inside the guard factory. On this class
   * rather than `AuthManagerContract`, which describes what a *request* needs.
   */
  getApiTokenStore(): ApiTokenStore | undefined {
    return this.apiTokenStore ?? undefined
  }
}

export type { AuthCredentials } from './types'
