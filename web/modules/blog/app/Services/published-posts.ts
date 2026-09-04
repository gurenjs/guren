import { Post, type PostRecord } from '../Models/Post.js'

/**
 * A future `publishedAt` is scheduled, not published: it stays out of the list,
 * the feed and the sitemap until the date arrives.
 */
export function isPublished(post: Pick<PostRecord, 'publishedAt'>, now: Date = new Date()): boolean {
  return post.publishedAt !== null && post.publishedAt.getTime() <= now.getTime()
}

export interface PublishedPost {
  slug: string
  title: string
  description: string | null
  publishedAt: Date
}

/**
 * Published posts, newest first — the one query behind the blog index, the RSS
 * feed and the sitemap. Summary columns only: no caller here needs the two
 * large body columns.
 */
export async function listPublishedPosts(now: Date = new Date()): Promise<PublishedPost[]> {
  const records = await Post.select('slug', 'title', 'description', 'publishedAt')
    .whereNotNull('publishedAt')
    .orderBy('publishedAt', 'desc')
    .get()

  return records
    .filter((record) => isPublished(record, now))
    .map((record) => ({
      slug: record.slug,
      title: record.title,
      description: record.description,
      // Non-null by the isPublished filter above.
      publishedAt: record.publishedAt as Date,
    }))
}
