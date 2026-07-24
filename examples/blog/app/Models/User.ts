import { AuthenticatableModel, type HasManyRecord } from '@guren/core'
import { users } from '../../db/schema.js'
import type { PostRecord } from './Post.js'

export type UserRecord = typeof users.$inferSelect
export type NewUserRecord = typeof users.$inferInsert

export class User extends AuthenticatableModel<UserRecord> {
  static override table = users
  static fillable = ['name', 'email', 'password', 'emailVerifiedAt', 'githubId', 'googleId']
  static guarded = ['id', 'passwordHash', 'rememberToken']
  static override hidden = ['passwordHash', 'rememberToken']
  static override readonly recordType = {} as UserRecord
  static override readonly createType = {} as Omit<NewUserRecord, 'passwordHash'> & {
    password: string
  }
  static override relationTypes: { posts: HasManyRecord<PostRecord> } = {
    posts: [],
  }
}

User.hasMany('posts', () => import('./Post.js').then((module) => module.Post), 'authorId', 'id')
