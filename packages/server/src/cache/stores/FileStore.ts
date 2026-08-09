import { readFile, writeFile, unlink, readdir, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import type { CacheStore, FileStoreOptions, CachedItem } from '../types'

/**
 * File-based cache store.
 *
 * @example
 * ```ts
 * const store = new FileStore({ path: './storage/cache' })
 *
 * await store.set('user:1', { name: 'John' }, 3600)
 * const user = await store.get<User>('user:1')
 * ```
 */
export class FileStore implements CacheStore {
  private readonly basePath: string
  private readonly extension: string
  private readonly now: () => number

  constructor(options: FileStoreOptions) {
    this.basePath = options.path
    this.extension = options.extension ?? '.cache'
    this.now = options.now ?? Date.now
  }

  /**
   * Generate a hashed filename for a cache key.
   */
  private getFilePath(key: string): string {
    const hash = createHash('sha256').update(key).digest('hex')
    // Use first 2 chars as subdirectory for better filesystem distribution
    const dir = hash.slice(0, 2)
    return join(this.basePath, dir, `${hash}${this.extension}`)
  }

  /**
   * Ensure the cache directory exists.
   */
  private async ensureDirectory(filePath: string): Promise<void> {
    const dir = dirname(filePath)
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }
  }

  /**
   * Read a cache file.
   */
  private async readCacheFile<T>(filePath: string): Promise<CachedItem<T> | null> {
    try {
      const content = await readFile(filePath, 'utf-8')
      return JSON.parse(content) as CachedItem<T>
    } catch {
      return null
    }
  }

  /**
   * Write a cache file.
   */
  private async writeCacheFile<T>(filePath: string, item: CachedItem<T>): Promise<void> {
    await this.ensureDirectory(filePath)
    await writeFile(filePath, JSON.stringify(item), 'utf-8')
  }

  /**
   * Delete a cache file.
   */
  private async deleteCacheFile(filePath: string): Promise<boolean> {
    try {
      await unlink(filePath)
      return true
    } catch {
      return false
    }
  }

  /**
   * Check if a cached item is expired.
   */
  private isExpired(item: CachedItem): boolean {
    return item.expiresAt !== null && item.expiresAt <= this.now()
  }

  async get<T>(key: string): Promise<T | null> {
    const filePath = this.getFilePath(key)
    const item = await this.readCacheFile<T>(filePath)

    if (!item) {
      return null
    }

    if (this.isExpired(item)) {
      await this.deleteCacheFile(filePath)
      return null
    }

    return item.value
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    const filePath = this.getFilePath(key)
    const expiresAt = ttl ? this.now() + ttl * 1000 : null

    await this.writeCacheFile(filePath, {
      value,
      expiresAt,
    })
  }

  async has(key: string): Promise<boolean> {
    const value = await this.get(key)
    return value !== null
  }

  async delete(key: string): Promise<boolean> {
    const filePath = this.getFilePath(key)
    return this.deleteCacheFile(filePath)
  }

  async clear(): Promise<void> {
    if (!existsSync(this.basePath)) {
      return
    }

    await rm(this.basePath, { recursive: true, force: true })
    await mkdir(this.basePath, { recursive: true })
  }

  async increment(key: string, value = 1): Promise<number> {
    const current = await this.get<number>(key)
    const newValue = (current ?? 0) + value

    // Preserve TTL if item exists
    const filePath = this.getFilePath(key)
    const item = await this.readCacheFile<number>(filePath)
    const ttl = item?.expiresAt
      ? Math.max(0, Math.ceil((item.expiresAt - this.now()) / 1000))
      : undefined

    await this.set(key, newValue, ttl)
    return newValue
  }

  async decrement(key: string, value = 1): Promise<number> {
    return this.increment(key, -value)
  }

  async remember<T>(key: string, ttl: number, callback: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key)

    if (cached !== null) {
      return cached
    }

    const value = await callback()
    await this.set(key, value, ttl)
    return value
  }

  async rememberForever<T>(key: string, callback: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key)

    if (cached !== null) {
      return cached
    }

    const value = await callback()
    await this.set(key, value)
    return value
  }

  async getMany<T>(keys: string[]): Promise<Map<string, T | null>> {
    const result = new Map<string, T | null>()

    for (const key of keys) {
      result.set(key, await this.get<T>(key))
    }

    return result
  }

  async setMany<T>(items: Map<string, T>, ttl?: number): Promise<void> {
    const promises: Promise<void>[] = []

    for (const [key, value] of items) {
      promises.push(this.set(key, value, ttl))
    }

    await Promise.all(promises)
  }

  async deleteMany(keys: string[]): Promise<number> {
    let deleted = 0

    for (const key of keys) {
      if (await this.delete(key)) {
        deleted++
      }
    }

    return deleted
  }

  async ttl(key: string): Promise<number> {
    const filePath = this.getFilePath(key)
    const item = await this.readCacheFile(filePath)

    if (!item) {
      return -2
    }

    if (this.isExpired(item)) {
      await this.deleteCacheFile(filePath)
      return -2
    }

    if (item.expiresAt === null) {
      return -1
    }

    return Math.max(0, Math.ceil((item.expiresAt - this.now()) / 1000))
  }

  /**
   * Clean up expired cache files.
   * This can be called periodically to free disk space.
   */
  async cleanup(): Promise<number> {
    let cleaned = 0

    if (!existsSync(this.basePath)) {
      return cleaned
    }

    const subdirs = await readdir(this.basePath)

    for (const subdir of subdirs) {
      const subdirPath = join(this.basePath, subdir)
      let files: string[]

      try {
        files = await readdir(subdirPath)
      } catch {
        continue
      }

      for (const file of files) {
        if (!file.endsWith(this.extension)) {
          continue
        }

        const filePath = join(subdirPath, file)
        const item = await this.readCacheFile(filePath)

        if (item && this.isExpired(item)) {
          await this.deleteCacheFile(filePath)
          cleaned++
        }
      }
    }

    return cleaned
  }

  /**
   * Get the base path.
   */
  getBasePath(): string {
    return this.basePath
  }
}
