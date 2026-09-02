import type { Model, PlainObject } from '@guren/orm'
import type { PasswordHasher } from '../password/PasswordHasher'
import { DefaultHasher } from '../password/DefaultHasher'
import type { AuthCredentials, Authenticatable } from '../types'
import { BaseUserProvider } from './UserProvider'

interface CredentialColumnSource {
  resolvePasswordHashField(): string
  resolveRememberTokenField(): string
}

/**
 * Capability check, not `instanceof AuthenticatableModel`: a nominal check
 * silently fails when two copies of @guren/server are loaded (src and dist
 * coexist through workspace symlinks), which would ignore a renamed
 * passwordHashField without any signal. Same duck-typing idiom as
 * BaseUserProvider's remember-token support.
 */
function credentialColumnSource(model: typeof Model): CredentialColumnSource | null {
  const candidate = model as Partial<CredentialColumnSource>
  return typeof candidate.resolvePasswordHashField === 'function' &&
    typeof candidate.resolveRememberTokenField === 'function'
    ? (candidate as CredentialColumnSource)
    : null
}

export interface ModelUserProviderOptions {
  idColumn?: string
  usernameColumn?: string
  passwordColumn?: string
  rememberTokenColumn?: string
  hasher?: PasswordHasher
  credentialsPasswordField?: string
}

type ModelConstructor = typeof Model<PlainObject>

type InferRecord<T extends typeof Model> = Awaited<ReturnType<T['find']>> extends infer R ? (R extends object ? R : PlainObject) : PlainObject

export class ModelUserProvider<User extends Authenticatable = Authenticatable> extends BaseUserProvider<User> {
  private readonly idColumn: string
  private readonly usernameColumn: string
  private readonly passwordColumn: string
  private readonly rememberTokenColumn: string
  private readonly hasher: PasswordHasher
  private readonly credentialsPasswordField: string

  constructor(private readonly model: typeof Model, options: ModelUserProviderOptions = {}) {
    super()
    // The model contract is the single source of truth for credential
    // columns: an AuthenticatableModel that renames passwordHashField or
    // rememberTokenField is picked up here without repeating the name.
    // Explicit options remain as overrides for non-authenticatable targets.
    const authModel = credentialColumnSource(model)
    this.idColumn = options.idColumn ?? 'id'
    this.usernameColumn = options.usernameColumn ?? 'email'
    this.passwordColumn = options.passwordColumn ?? authModel?.resolvePasswordHashField() ?? 'passwordHash'
    this.rememberTokenColumn = options.rememberTokenColumn ?? authModel?.resolveRememberTokenField() ?? 'rememberToken'
    this.hasher = options.hasher ?? new DefaultHasher()
    this.credentialsPasswordField = options.credentialsPasswordField ?? 'password'
  }

  private cast(record: unknown): User | null {
    if (record && typeof record === 'object') {
      return record as User
    }

    return null
  }

  override async retrieveById(identifier: unknown): Promise<User | null> {
    const record = await (this.model as typeof Model).find(identifier, this.idColumn)
    return this.cast(record)
  }

  override async retrieveByCredentials(credentials: AuthCredentials): Promise<User | null> {
    const rememberToken = credentials['rememberToken'] ?? credentials['remember_token']
    if (rememberToken != null) {
      const records = await (this.model as typeof Model).where({ [this.rememberTokenColumn]: rememberToken })
      return this.cast(records[0] ?? null)
    }

    const username = credentials[this.usernameColumn]
    if (username == null) {
      return null
    }

    const records = await (this.model as typeof Model).where({ [this.usernameColumn]: username })
    return this.cast(records[0] ?? null)
  }

  override async validateCredentials(user: User, credentials: AuthCredentials): Promise<boolean> {
    const plain = credentials[this.credentialsPasswordField]
    if (typeof plain !== 'string') {
      return false
    }

    const hashed = (user as PlainObject)[this.passwordColumn]
    if (typeof hashed !== 'string') {
      // Run a dummy hash to prevent timing-based user enumeration.
      // This ensures requests take the same time whether or not the user exists.
      await this.hasher.hash('dummy-timing-equalization')
      return false
    }

    return this.hasher.verify(hashed, plain)
  }

  override getId(user: User): unknown {
    return (user as PlainObject)[this.idColumn]
  }

  /**
   * Strip the password hash, remember token, and the model's `hidden`
   * fields before the record leaves the auth layer. Credential
   * validation happens on the raw record before sanitizing, so this
   * never affects login — only what `auth.user()` exposes.
   */
  sanitize(user: User): User {
    // Block both the option-selected columns and the model's own resolved
    // credential columns: with an explicit passwordColumn override pointing
    // elsewhere, the model-owned hash column would otherwise leak through
    // auth.user() unless the app also listed it in hidden.
    const authModel = credentialColumnSource(this.model)
    const blocked = new Set<string>([
      this.passwordColumn,
      this.rememberTokenColumn,
      ...(authModel ? [authModel.resolvePasswordHashField(), authModel.resolveRememberTokenField()] : []),
      ...(((this.model as typeof Model).hidden as string[] | undefined) ?? []),
    ])

    const clean: PlainObject = {}
    for (const [key, value] of Object.entries(user as PlainObject)) {
      if (!blocked.has(key)) {
        clean[key] = value
      }
    }

    return clean as User
  }

  override async setRememberToken(user: User, token: string | null): Promise<void> {
    if (typeof (user as PlainObject)[this.rememberTokenColumn] !== 'undefined') {
      ;(user as PlainObject)[this.rememberTokenColumn] = token
      // forceUpdate: the remember-token column is a trusted server-side
      // write and is typically not in the model's fillable allowlist.
      await (this.model as typeof Model).forceUpdate({ [this.idColumn]: this.getId(user) }, { [this.rememberTokenColumn]: token })
    }
  }

  override async getRememberToken(user: User): Promise<string | null> {
    const token = (user as PlainObject)[this.rememberTokenColumn]
    if (token == null) {
      return null
    }

    return String(token)
  }
}
