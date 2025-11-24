import type { Context } from 'hono'
import type { Model } from '@guren/orm'
import type { PlainObject } from '@guren/orm/Model'
import { getSessionFromContext } from '../http/middleware/session'
import { RequestAuthContext } from './RequestAuthContext'
import { ModelUserProvider, type ModelUserProviderOptions } from './providers/ModelUserProvider'
import { SessionGuard } from './SessionGuard'
import { ScryptHasher } from './password/ScryptHasher'
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

  createAuthContext(ctx: Context, options: AttachContextOptions = {}): AuthContext {
    const guardName = options.guard ?? this.defaultGuard
    const session = getSessionFromContext(ctx)

    const guardFactory = (name?: string) => {
      const targetName = name ?? guardName
      return this.createGuard(targetName, {
        ctx,
        session,
        manager: this,
      })
    }

    return new RequestAuthContext(this, ctx, session, guardFactory)
  }

  async attempt(name: string, ctx: Context, credentials: AuthCredentials, remember?: boolean): Promise<boolean> {
    const guard = this.createAuthContext(ctx, { guard: name }).guard(name)
    return guard.attempt(credentials, remember)
  }

  /**
   * Shorthand method to register a model-based authentication provider and session guard.
   * This simplifies the common case of authenticating users via a database model.
   *
   * @param model - The model class to use for user authentication
   * @param options - Options for the ModelUserProvider (partial, with defaults)
   * @param providerName - Name for the provider (defaults to 'users')
   * @param guardName - Name for the guard (defaults to 'web')
   */
  useModel(
    model: typeof Model<PlainObject>,
    options: Partial<ModelUserProviderOptions> = {},
    providerName = 'users',
    guardName = 'web',
  ): void {
    const defaultOptions: ModelUserProviderOptions = {
      usernameColumn: 'email',
      passwordColumn: 'passwordHash',
      rememberTokenColumn: 'rememberToken',
      credentialsPasswordField: 'password',
      hasher: new ScryptHasher(),
      ...options,
    }

    this.registerProvider(providerName, () => new ModelUserProvider(model, defaultOptions))

    this.registerGuard(guardName, ({ session, manager }) => {
      const provider = manager.getProvider(providerName)
      return new SessionGuard({ provider, session })
    })

    this.setDefaultGuard(guardName)
  }
}

export type { AuthCredentials } from './types'
