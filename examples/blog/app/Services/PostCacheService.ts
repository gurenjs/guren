import { createCacheManager, type CacheManager } from '@guren/server'
import { Post, type PostWithAuthor } from '../Models/Post.js'
import type { PaginationMeta } from '@guren/orm'

/**
 * Cache service for posts.
 * Provides cached access to post data with automatic invalidation.
 */
export class PostCacheService {
  private cache: CacheManager

  constructor() {
    this.cache = createCacheManager({
      default: 'memory',
      stores: {
        memory: { driver: 'memory' },
      },
    })
  }

  /**
   * Get paginated posts with caching.
   * Cache key includes page number for per-page caching.
   */
  async getPaginatedPosts(
    page: number,
    perPage: number
  ): Promise<{ posts: PostWithAuthor[]; meta: PaginationMeta }> {
    const cacheKey = `posts:page:${page}:per:${perPage}`
    const ttl = 60 // 1 minute cache

    return this.cache.store().remember(cacheKey, ttl, async () => {
      const { data: posts, meta } = await Post.withPaginate('author', {
        page,
        perPage,
        orderBy: ['id', 'desc'],
      })
      return { posts, meta }
    })
  }

  /**
   * Get a single post with caching.
   */
  async getPost(id: number): Promise<PostWithAuthor | null> {
    const cacheKey = `posts:${id}`
    const ttl = 300 // 5 minutes cache

    return this.cache.store().remember(cacheKey, ttl, async () => {
      const [post] = await Post.with('author', { id })
      return post ?? null
    })
  }

  /**
   * Invalidate post cache when a post is created or updated.
   */
  async invalidatePost(id: number): Promise<void> {
    // Invalidate specific post cache
    await this.cache.store().delete(`posts:${id}`)

    // Invalidate paginated caches using tags if available
    // For now, we'll just clear the most common pages
    for (let page = 1; page <= 5; page++) {
      await this.cache.store().delete(`posts:page:${page}:per:6`)
    }
  }

  /**
   * Clear all post caches.
   */
  async clearAll(): Promise<void> {
    await this.cache.store().clear()
  }
}

// Singleton instance
let postCacheService: PostCacheService | null = null

/**
 * Get the post cache service singleton.
 */
export function getPostCacheService(): PostCacheService {
  if (!postCacheService) {
    postCacheService = new PostCacheService()
  }
  return postCacheService
}
