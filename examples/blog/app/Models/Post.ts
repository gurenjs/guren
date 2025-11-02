import { Model } from '@guren/orm'
import { posts } from '../../db/schema.js'

export type PostRecord = typeof posts.$inferSelect

export class Post extends Model<PostRecord> {
  static override table = posts
  static override readonly recordType = {} as PostRecord
}
