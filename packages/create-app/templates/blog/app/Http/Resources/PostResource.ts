import { Resource, type WithRelations } from '@guren/core'
import { Post } from '../../Models/Post.js'
import type { PostRecord, PostAuthorSummary } from '../../Models/Post.js'

type PostWithAuthor = WithRelations<typeof Post, 'author'>

export interface PostResourceData extends Record<string, unknown> {
  id: number
  title: string
  excerpt: string
  body: string
  authorId: number
  // Serialized here because `created_at` is a string on SQLite and a Date on
  // PostgreSQL and MySQL — pages should not have to know which.
  createdAt: string
  author?: PostAuthorSummary
}

export class PostResource extends Resource<PostRecord | PostWithAuthor> {
  toArray(): PostResourceData {
    const post = this.resource

    return {
      id: post.id as number,
      title: post.title as string,
      excerpt: post.excerpt as string,
      body: post.body as string,
      authorId: post.authorId as number,
      createdAt: new Date(post.createdAt as string | Date).toISOString(),
      author: this.whenLoaded('author', () => ({
        id: (post as PostWithAuthor).author?.id,
        name: (post as PostWithAuthor).author?.name,
      })) as PostAuthorSummary | undefined,
    }
  }

  override toJSON(): PostResourceData {
    return super.toJSON() as PostResourceData
  }
}
