import type { Model } from '@guren/orm'
import type { PlainObject } from '@guren/orm/Model'
import type { PasswordHasher } from '../password/PasswordHasher'
import { ScryptHasher } from '../password/ScryptHasher'
import type { AuthCredentials, Authenticatable } from '../types'
import { BaseUserProvider } from './UserProvider'

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
    this.idColumn = options.idColumn ?? 'id'
    this.usernameColumn = options.usernameColumn ?? 'email'
    this.passwordColumn = options.passwordColumn ?? 'password'
    this.rememberTokenColumn = options.rememberTokenColumn ?? 'remember_token'
    this.hasher = options.hasher ?? new ScryptHasher()
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
      return false
    }

    return this.hasher.verify(hashed, plain)
  }

  override getId(user: User): unknown {
    return (user as PlainObject)[this.idColumn]
  }

  override async setRememberToken(user: User, token: string | null): Promise<void> {
    if (typeof (user as PlainObject)[this.rememberTokenColumn] !== 'undefined') {
      ;(user as PlainObject)[this.rememberTokenColumn] = token
      await (this.model as typeof Model).update({ [this.idColumn]: this.getId(user) }, { [this.rememberTokenColumn]: token })
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
