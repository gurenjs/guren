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

export class PostCacheService {
  constructor(private readonly cache: CacheManager) {}

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

  async getPost(id: number): Promise<PostWithAuthor | null> {
    const cacheKey = `posts:${id}`
    const ttl = 300 // 5 minutes cache

    return this.cache.store().remember(cacheKey, ttl, async () => {
      const [post] = await Post.with('author', { id })
      return post ?? null
    })
  }

  async invalidatePost(id: number): Promise<void> {
    await this.cache.store().delete(`posts:${id}`)

    // Approximate: past POSTS_PAGE_INVALIDATION_DEPTH pages stay stale until TTL.
    for (let page = 1; page <= POSTS_PAGE_INVALIDATION_DEPTH; page++) {
      await this.cache.store().delete(`posts:page:${page}:per:${POSTS_PAGE_SIZE}`)
    }
  }

  async clearAll(): Promise<void> {
    await this.cache.store().clear()
  }
}
