import { Model, type BelongsToRecord } from '@guren/orm'
import { posts } from '../../db/schema.js'
import type { UserRecord } from './User.js'

export type PostRecord = typeof posts.$inferSelect
export type PostAuthorSummary = Pick<UserRecord, 'id' | 'name'>
export type PostWithAuthor = PostRecord & { author: BelongsToRecord<PostAuthorSummary> }

export class Post extends Model<PostRecord> {
  static override table = posts
  static override readonly recordType = {} as PostRecord
  static override relationTypes: { author: BelongsToRecord<PostAuthorSummary> } = {
    author: null,
  }
}
