import type { CacheManager, PaginatedResult } from '@guren/core'
import { Task, type TaskRecord } from '../Models/Task.js'

export const TASKS_PAGE_SIZE = 15
const TASKS_PAGE_CACHE_TTL_SECONDS = 60
const TASKS_PAGE_INVALIDATION_DEPTH = 10
const TASKS_FILTER_SEGMENTS = ['all', 'true', 'false'] as const

type TaskListFilters = {
  completed?: boolean
}

function normalizePage(page: number): number {
  return Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1
}

function normalizePerPage(perPage: number): number {
  return Number.isFinite(perPage) && perPage >= 1 ? Math.floor(perPage) : TASKS_PAGE_SIZE
}

function completedFilterSegment(completed?: boolean): (typeof TASKS_FILTER_SEGMENTS)[number] {
  if (completed === true) return 'true'
  if (completed === false) return 'false'
  return 'all'
}

export class TaskCacheService {
  constructor(private readonly cache: CacheManager) {}

  async getUserTasks(
    userId: number,
    page: number,
    perPage = TASKS_PAGE_SIZE,
    filters: TaskListFilters = {},
  ): Promise<PaginatedResult<TaskRecord>> {
    const normalizedPage = normalizePage(page)
    const normalizedPerPage = normalizePerPage(perPage)
    const filterSegment = completedFilterSegment(filters.completed)
    const cacheKey = `tasks:user:${userId}:page:${normalizedPage}:per:${normalizedPerPage}:completed:${filterSegment}`

    return this.cache.store().remember(cacheKey, TASKS_PAGE_CACHE_TTL_SECONDS, async () => {
      const where = {
        userId,
        ...(filters.completed === undefined ? {} : { completed: filters.completed }),
      }

      return Task.paginate({
        where,
        page: normalizedPage,
        perPage: normalizedPerPage,
        orderBy: ['id', 'desc'],
      })
    })
  }

  async getTask(id: number): Promise<Task | null> {
    const cacheKey = `tasks:${id}`
    const ttl = 300 // 5 minutes cache

    return this.cache.store().remember(cacheKey, ttl, async () => {
      return Task.find(id)
    })
  }

  async invalidateTask(id: number, userId: number): Promise<void> {
    await this.cache.store().delete(`tasks:${id}`)

    for (let page = 1; page <= TASKS_PAGE_INVALIDATION_DEPTH; page++) {
      for (const completed of TASKS_FILTER_SEGMENTS) {
        await this.cache.store().delete(`tasks:user:${userId}:page:${page}:per:${TASKS_PAGE_SIZE}:completed:${completed}`)
      }
    }
  }

  async invalidateUserTasks(userId: number): Promise<void> {
    for (let page = 1; page <= TASKS_PAGE_INVALIDATION_DEPTH; page++) {
      for (const completed of TASKS_FILTER_SEGMENTS) {
        await this.cache.store().delete(`tasks:user:${userId}:page:${page}:per:${TASKS_PAGE_SIZE}:completed:${completed}`)
      }
    }
  }

  async clearAll(): Promise<void> {
    await this.cache.store().clear()
  }
}
