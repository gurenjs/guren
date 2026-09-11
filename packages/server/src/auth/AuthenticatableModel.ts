import { Model, type PlainObject } from '@guren/orm'
import type { PasswordHasher } from './password/PasswordHasher'
import { DefaultHasher } from './password/DefaultHasher'

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

  /** The model author's own choice, read by `ModelUserProvider` so one model and its provider cannot write at different parameters. */
  static explicitPasswordHasher(): PasswordHasher | null {
    return this.passwordHasher ?? null
  }

  /**
   * Assigned by `AuthManager.useModel()` at bind time, never by the model's
   * author. A class evaluating before `createApp()` therefore pins nothing, and
   * a model no app ever bound falls through to scrypt (a seeder run bare, a unit test).
   */
  static configuredPasswordHasher: PasswordHasher | null = null

  protected static resolvePasswordHasher(): PasswordHasher {
    return this.passwordHasher ?? this.configuredPasswordHasher ?? new DefaultHasher()
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
