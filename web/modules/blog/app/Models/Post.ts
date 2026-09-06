import { defineModel } from '@guren/core'
import { posts } from '../../../../db/schema.js'

export type PostRecord = typeof posts.$inferSelect
export type NewPostRecord = typeof posts.$inferInsert

export class Post extends defineModel(posts, {
  fillable: ['slug', 'title', 'description', 'bodyMarkdown', 'bodyHtml', 'publishedAt', 'updatedAt'],
}) {}
