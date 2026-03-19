import { createCacheManager, type CacheManager } from '@guren/server'
import { Task } from '../Models/Task.js'
import type { PaginationMeta } from '@guren/orm'

/**
 * Cache service for tasks.
 * Provides cached access to task data with automatic invalidation.
 */
export class TaskCacheService {
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
   * Get paginated tasks for a user with caching.
   */
  async getUserTasks(
    userId: number,
    page: number,
    perPage: number
  ): Promise<{ tasks: Task[]; meta: PaginationMeta }> {
    const cacheKey = `tasks:user:${userId}:page:${page}:per:${perPage}`
    const ttl = 60 // 1 minute cache

    return this.cache.store().remember(cacheKey, ttl, async () => {
      const { data: tasks, meta } = await Task.paginate({
        where: { userId },
        page,
        perPage,
        orderBy: ['id', 'desc'],
      })
      return { tasks, meta }
    })
  }

  /**
   * Get a single task with caching.
   */
  async getTask(id: number): Promise<Task | null> {
    const cacheKey = `tasks:${id}`
    const ttl = 300 // 5 minutes cache

    return this.cache.store().remember(cacheKey, ttl, async () => {
      return Task.find(id)
    })
  }

  /**
   * Invalidate task cache when a task is created or updated.
   */
  async invalidateTask(id: number, userId: number): Promise<void> {
    // Invalidate specific task cache
    await this.cache.store().delete(`tasks:${id}`)

    // Invalidate user's paginated task caches
    for (let page = 1; page <= 5; page++) {
      await this.cache.store().delete(`tasks:user:${userId}:page:${page}:per:15`)
    }
  }

  /**
   * Invalidate all task caches for a user.
   */
  async invalidateUserTasks(userId: number): Promise<void> {
    for (let page = 1; page <= 10; page++) {
      await this.cache.store().delete(`tasks:user:${userId}:page:${page}:per:15`)
    }
  }

  /**
   * Clear all task caches.
   */
  async clearAll(): Promise<void> {
    await this.cache.store().clear()
  }
}

// Singleton instance
let taskCacheService: TaskCacheService | null = null

/**
 * Get the task cache service singleton.
 */
export function getTaskCacheService(): TaskCacheService {
  if (!taskCacheService) {
    taskCacheService = new TaskCacheService()
  }
  return taskCacheService
}
