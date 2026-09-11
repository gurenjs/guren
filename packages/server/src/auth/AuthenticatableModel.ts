import { Model, type PlainObject } from '@guren/orm'
import type { PasswordHasher } from './password/PasswordHasher'
import { configuredPasswordHasher } from './password/configured-hasher'

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

  protected static override async preparePersistencePayload(data: PlainObject): Promise<PlainObject> {
    const basePayload = await super.preparePersistencePayload(data)
    const passwordField = this.resolvePasswordField()

    if (!(passwordField in basePayload)) {
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
