import { defineModel, type BelongsToRecord } from '@guren/orm'
import { posts } from '../../db/schema.js'
import type { UserRecord } from './User.js'

export type PostRecord = typeof posts.$inferSelect
export type NewPostRecord = typeof posts.$inferInsert
export type PostAuthorSummary = Pick<UserRecord, 'id' | 'name'>

export class Post extends defineModel(posts) {
  static fillable = ['title', 'excerpt', 'body', 'authorId']

  static override relationTypes: { author: BelongsToRecord<PostAuthorSummary> } = {
    author: null,
  }
}

Post.belongsTo('author', () => import('./User.js').then((module) => module.User), 'authorId', 'id')
