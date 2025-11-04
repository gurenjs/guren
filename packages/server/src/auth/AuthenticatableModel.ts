import type { PlainObject } from '@guren/orm/Model'
import { Model } from '@guren/orm/Model'
import type { PasswordHasher } from './password/PasswordHasher'
import { ScryptHasher } from './password/ScryptHasher'

export abstract class AuthenticatableModel<TRecord extends PlainObject = PlainObject> extends Model<TRecord> {
  protected static passwordField = 'password'
  protected static passwordHashField = 'passwordHash'
  protected static passwordHasher: PasswordHasher | null = null

  protected static resolvePasswordField(): string {
    return (this.passwordField ?? 'password') as string
  }

  protected static resolvePasswordHashField(): string {
    return (this.passwordHashField ?? 'passwordHash') as string
  }

  protected static resolvePasswordHasher(): PasswordHasher {
    if (this.passwordHasher) {
      return this.passwordHasher
    }

    const hasher = new ScryptHasher()
    this.passwordHasher = hasher
    return hasher
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
