import { AuthenticatableModel, defineModel, type HasManyRecord } from '@guren/core'
import { users } from '../../db/schema.js'
import type { PostRecord } from './Post.js'

export type UserRecord = typeof users.$inferSelect
export type NewUserRecord = typeof users.$inferInsert

export class User extends defineModel(users, {
  base: AuthenticatableModel,
  optionalOnCreate: ['passwordHash'],
  requireOnCreate: ['password'],
  // What a request may set. emailVerifiedAt and the provider ids are chosen by
  // the server and written through `set` (RFC 0031).
  fillable: ['name', 'email', 'password'],
  hidden: ['passwordHash', 'rememberToken'],
}) {
  static override relationTypes: { posts: HasManyRecord<PostRecord> } = {
    posts: [],
  }
}

User.hasMany('posts', () => import('./Post.js').then((module) => module.Post), 'authorId', 'id')
