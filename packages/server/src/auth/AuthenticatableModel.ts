import { Model, type PlainObject } from '@guren/orm'
import type { PasswordHasher } from './password/PasswordHasher'
import { configuredPasswordHasher } from './password/configured-hasher'

/**
 * Marks a payload whose password value is already hashed, out of band because
 * an in-place model has only one column to read. Stripped before the payload
 * reaches the database; `storePasswordHash()` is the only writer.
 */
const PRECOMPUTED_HASH = Symbol('guren.auth.precomputedPasswordHash')

export abstract class AuthenticatableModel<TRecord extends PlainObject = PlainObject> extends Model<TRecord> {
  static override readonly createType: {
    password?: string
    plainPassword?: string
  } = undefined as unknown as {
    password?: string
    plainPassword?: string
  }
  protected static passwordField = 'password'
  protected static passwordHashField = 'passwordHash'
  protected static rememberTokenField = 'rememberToken'
  protected static passwordHasher: PasswordHasher | null = null

  protected static resolvePasswordField(): string {
    return (this.passwordField ?? 'password') as string
  }

  static resolvePasswordHashField(): string {
    return (this.passwordHashField ?? 'passwordHash') as string
  }

  static resolveRememberTokenField(): string {
    return (this.rememberTokenField ?? 'rememberToken') as string
  }

  /**
   * Credential columns can never be mass-assigned: the resolved password-hash
   * column (unless the model hashes in place into the password field itself)
   * and the remember-token column. Resolved at call time so a renamed column
   * stays covered. Use `forceCreate()`/`forceUpdate()` for trusted server-side
   * values such as `passwordHash: 'oauth:...'`.
   */
  protected static override deniedFields(): string[] {
    const denied = [...super.deniedFields()]
    const hashField = this.resolvePasswordHashField()
    if (hashField !== this.resolvePasswordField()) {
      denied.push(hashField)
    }
    denied.push(this.resolveRememberTokenField())
    return denied
  }

  /**
   * An explicit static `passwordHasher` wins; otherwise the hasher the app's
   * `AuthManager` resolved, read per call through the process-wide container
   * (a model class has no other path to the app). Not cached, so the class
   * evaluating before `createApp()` cannot pin the fallback.
   */
  protected static resolvePasswordHasher(): PasswordHasher {
    return this.passwordHasher ?? configuredPasswordHasher()
  }

  /**
   * Persist an already-hashed password without hashing it again. A model that
   * hashes in place (`passwordField === passwordHashField`) cannot tell a hash
   * from a plaintext by column name, so a rehash written through `update()`
   * would be hashed a second time and lock the account out.
   */
  static async storePasswordHash(where: PlainObject, column: string, hash: string): Promise<void> {
    await (this as unknown as typeof Model).forceUpdate(where, {
      [column]: hash,
      [PRECOMPUTED_HASH]: true,
    } as PlainObject)
  }

  protected static override async preparePersistencePayload(data: PlainObject): Promise<PlainObject> {
    const precomputed = Reflect.get(data, PRECOMPUTED_HASH) === true
    const incoming = { ...data }
    Reflect.deleteProperty(incoming, PRECOMPUTED_HASH)
    const basePayload = await super.preparePersistencePayload(incoming)
    const passwordField = this.resolvePasswordField()

    if (precomputed || !(passwordField in basePayload)) {
      return basePayload
    }

    const payload = { ...basePayload }
    const plainPassword = payload[passwordField]
    const hashField = this.resolvePasswordHashField()

    if (typeof plainPassword === 'string' && plainPassword.length > 0) {
      const hasher = this.resolvePasswordHasher()
      payload[hashField] = await hasher.hash(plainPassword)
    }

    if (passwordField !== hashField) {
      delete payload[passwordField]
    }
    return payload
  }
}
