import { AuthenticatableModel, defineModel } from '@guren/core'
import { users } from '../../../../db/schema.js'

export type UserRecord = typeof users.$inferSelect
export type NewUserRecord = typeof users.$inferInsert

// Accounts come only from GitHub OAuth, so passwordHash is never supplied.
export class User extends defineModel(users, {
  base: AuthenticatableModel,
  optionalOnCreate: ['passwordHash'],
  fillable: ['name', 'email', 'githubId'],
  hidden: ['passwordHash', 'rememberToken'],
}) {}
