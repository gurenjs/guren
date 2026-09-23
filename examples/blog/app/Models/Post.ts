import { Attachable, defineModel, hasOneAttached, type BelongsToRecord } from '@guren/core'
import { posts } from '../../db/schema.js'
import type { UserRecord } from './User.js'

export type PostRecord = typeof posts.$inferSelect
export type NewPostRecord = typeof posts.$inferInsert
export type PostAuthorSummary = Pick<UserRecord, 'id' | 'name'>

export class Post extends Attachable(
  defineModel(posts, {
    // `authorId` is set from the signed-in user, never from request input.
    fillable: ['title', 'excerpt', 'body'],
  }),
  {
    cover: hasOneAttached({
      image: 'require',
      variants: { thumb: { width: 320 } },
    }),
  },
) {
  static override relationTypes: { author: BelongsToRecord<PostAuthorSummary> } = {
    author: null,
  }
}

Post.belongsTo('author', () => import('./User.js').then((module) => module.User), 'authorId', 'id')
