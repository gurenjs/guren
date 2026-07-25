import { AuthenticatableModel } from '@guren/core'
import { users } from '../../../../db/schema.js'

export type UserRecord = typeof users.$inferSelect
export type NewUserRecord = typeof users.$inferInsert

// Accounts are created exclusively through GitHub OAuth (passwordless), so
// createType omits passwordHash and no password field exists at all.
export class User extends AuthenticatableModel<UserRecord> {
  static override table = users
  static fillable = ['name', 'email', 'githubId']
  static guarded = ['id', 'passwordHash', 'rememberToken']
  static override hidden = ['passwordHash', 'rememberToken']
  static override readonly recordType = {} as UserRecord
  static override readonly createType = {} as Omit<NewUserRecord, 'passwordHash'>
}
