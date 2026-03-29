import type { CacheManager, PaginatedResult, WithRelations } from '@guren/core'
import { Post } from '../Models/Post.js'

type PostWithAuthor = WithRelations<typeof Post, 'author'>
export const POSTS_PAGE_SIZE = 6
const POSTS_PAGE_CACHE_TTL_SECONDS = 60
const POSTS_PAGE_INVALIDATION_DEPTH = 5

function normalizePage(page: number): number {
  return Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1
}

function normalizePerPage(perPage: number): number {
  return Number.isFinite(perPage) && perPage >= 1 ? Math.floor(perPage) : POSTS_PAGE_SIZE
}

/**
 * Cache service for posts.
 * Provides cached access to post data with automatic invalidation.
 */
export class PostCacheService {
  constructor(private readonly cache: CacheManager) {}

  /**
   * Get paginated posts with caching.
   * Cache key includes page number for per-page caching.
   */
  async getPaginatedPosts(
    page: number,
    perPage = POSTS_PAGE_SIZE
  ): Promise<PaginatedResult<PostWithAuthor>> {
    const normalizedPage = normalizePage(page)
    const normalizedPerPage = normalizePerPage(perPage)
    const cacheKey = `posts:page:${normalizedPage}:per:${normalizedPerPage}`

    return this.cache.store().remember(cacheKey, POSTS_PAGE_CACHE_TTL_SECONDS, async () => {
      return Post.withPaginate('author', {
        page: normalizedPage,
        perPage: normalizedPerPage,
        orderBy: ['id', 'desc'],
      })
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
    for (let page = 1; page <= POSTS_PAGE_INVALIDATION_DEPTH; page++) {
      await this.cache.store().delete(`posts:page:${page}:per:${POSTS_PAGE_SIZE}`)
    }
  }

  /**
   * Clear all post caches.
   */
  async clearAll(): Promise<void> {
    await this.cache.store().clear()
  }
}
