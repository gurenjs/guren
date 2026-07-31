import { AuthenticatableModel, defineModel, type HasManyRecord } from '@guren/core'
import { users } from '../../db/schema.js'
import type { PostRecord } from './Post.js'

export type UserRecord = typeof users.$inferSelect

export class User extends defineModel(users, {
  base: AuthenticatableModel,
  // Derived from the plain `password`, so callers never set it directly
  optionalOnCreate: ['passwordHash'],
  requireOnCreate: ['password'],
}) {
  // passwordHash and rememberToken are denied from mass assignment by
  // AuthenticatableModel itself. `name` and `email` are the only remaining
  // columns, so this fillable list matches what would be mass-assignable
  // anyway — it stays explicit so a later column addition needs an opt-in.
  static fillable = ['name', 'email', 'password']

  // Never serialized by Model.serialize() and stripped from auth.user()
  static override hidden = ['passwordHash', 'rememberToken']

  static override relationTypes: { posts: HasManyRecord<PostRecord> } = {
    posts: [],
  }
}

User.hasMany('posts', () => import('./Post.js').then((module) => module.Post), 'authorId', 'id')
