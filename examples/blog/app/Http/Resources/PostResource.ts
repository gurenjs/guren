import { Resource } from '@guren/core'
import { Post } from '../../Models/Post.js'
import type { PostRecord, PostAuthorSummary } from '../../Models/Post.js'
import type { AttachmentData, WithRelations } from '@guren/core'

type PostWithAuthor = WithRelations<typeof Post, 'author'>
// `Post.withAttachments(records, ['cover'])` adds the typed `cover` property;
// records that skipped that call simply serialize `cover: null`.
type PostInput = (PostRecord | PostWithAuthor) & { cover?: AttachmentData | null }

export interface PostResourceData extends Record<string, unknown> {
  id: number
  title: string
  excerpt: string
  body: string | null
  cover: AttachmentData | null
  notificationArtifactPath: string
  broadcastChannels: {
    public: string
    private: string
  }
  author?: PostAuthorSummary
}

export class PostResource extends Resource<PostInput, PostResourceData> {
  toArray(): PostResourceData {
    const post = this.resource

    return {
      id: post.id,
      title: post.title,
      excerpt: post.excerpt,
      body: post.body,
      cover: post.cover ?? null,
      notificationArtifactPath: `notifications/posts/${post.id}.json`,
      broadcastChannels: {
        public: 'announcements',
        private: `posts.${post.id}`,
      },
      author: this.whenLoaded('author', () => ({
        id: (post as PostWithAuthor).author?.id,
        name: (post as PostWithAuthor).author?.name,
      })) as PostAuthorSummary | undefined,
    }
  }
}
