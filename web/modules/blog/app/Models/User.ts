import { AuthenticatableModel, defineModel } from '@guren/core'
import { users } from '../../../../db/schema.js'

export type UserRecord = typeof users.$inferSelect
export type NewUserRecord = typeof users.$inferInsert

// Accounts are created exclusively through GitHub OAuth (passwordless), so
// passwordHash is never supplied and no password is ever required — unlike a
// model that also offers password sign-up.
export class User extends defineModel(users, {
  base: AuthenticatableModel,
  optionalOnCreate: ['passwordHash'],
}) {
  static fillable = ['name', 'email', 'githubId']
  static override hidden = ['passwordHash', 'rememberToken']
}
