import { readFile, writeFile, unlink, readdir, mkdir, rm, rename, link } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { CacheStore, FileStoreOptions, CachedItem } from '../types'
import { withFileLock } from './file-lock'

// Locks only guard read-modify-write (add, increment). One held this long is taken
// over: its owner most likely died mid-operation, and losing one update beats a key
// that stays locked until someone deletes the directory.
const LOCK_TIMEOUT_MS = 5000

/** File-based cache store. */
export class FileStore implements CacheStore {
  private readonly basePath: string
  private readonly extension: string
  private readonly now: () => number

  constructor(options: FileStoreOptions) {
    this.basePath = options.path
    this.extension = options.extension ?? '.cache'
    this.now = options.now ?? Date.now
  }

  private getFilePath(key: string): string {
    const hash = createHash('sha256').update(key).digest('hex')
    // Subdirectory by hash prefix, for filesystem distribution.
    const dir = hash.slice(0, 2)
    return join(this.basePath, dir, `${hash}${this.extension}`)
  }

  private async ensureDirectory(filePath: string): Promise<void> {
    const dir = dirname(filePath)
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }
  }

  private async readCacheFile<T>(filePath: string): Promise<CachedItem<T> | null> {
    try {
      const content = await readFile(filePath, 'utf-8')
      return JSON.parse(content) as CachedItem<T>
    } catch {
      return null
    }
  }

  // The rename is what lets readers and plain writers skip the lock: a reader sees the old file or the new one, never a torn one.
  private async writeCacheFile<T>(filePath: string, item: CachedItem<T>): Promise<void> {
    await this.ensureDirectory(filePath)
    const temporary = `${filePath}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(item), 'utf-8')
      await rename(temporary, filePath)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  private locked<T>(filePath: string, callback: () => Promise<T>): Promise<T> {
    return withFileLock(`${filePath}.lock`, LOCK_TIMEOUT_MS, callback)
  }

  private async deleteCacheFile(filePath: string): Promise<boolean> {
    try {
      await unlink(filePath)
      return true
    } catch {
      return false
    }
  }

  private isExpired(item: CachedItem): boolean {
    return item.expiresAt !== null && item.expiresAt <= this.now()
  }

  async get<T>(key: string): Promise<T | null> {
    const filePath = this.getFilePath(key)
    const item = await this.readCacheFile<T>(filePath)

    if (!item) {
      return null
    }

    // Reads never delete an expired file: a writer may have replaced it since the read.
    if (this.isExpired(item)) {
      return null
    }

    return item.value
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    const filePath = this.getFilePath(key)
    const expiresAt = ttl ? this.now() + ttl * 1000 : null

    await this.writeCacheFile(filePath, { value, expiresAt })
  }

  async add<T>(key: string, value: T): Promise<boolean> {
    const filePath = this.getFilePath(key)
    return this.locked(filePath, async () => {
      const item = await this.readCacheFile(filePath)
      if (item && !this.isExpired(item)) return false
      await this.writeCacheFile(filePath, { value, expiresAt: null })
      return true
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
    const filePath = this.getFilePath(key)
    return this.locked(filePath, async () => {
      const item = await this.readCacheFile<number>(filePath)
      const active = item && !this.isExpired(item) ? item : null
      const newValue = (active?.value ?? 0) + value
      await this.writeCacheFile(filePath, { value: newValue, expiresAt: active?.expiresAt ?? null })
      return newValue
    })
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
      return -2
    }

    if (item.expiresAt === null) {
      return -1
    }

    return Math.max(0, Math.ceil((item.expiresAt - this.now()) / 1000))
  }

  /** Delete expired cache files; call periodically to free disk space. */
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
        if (item && this.isExpired(item) && await this.locked(filePath, () => this.removeIfExpired(filePath))) cleaned++
      }
    }

    return cleaned
  }

  // The lock keeps add() and increment() out; set() takes none, so the file is judged
  // after it is moved aside, and one set() replaced since the read goes back. A newer
  // set() already in its place wins (EEXIST). Readers miss the key while it is aside.
  private async removeIfExpired(filePath: string): Promise<boolean> {
    const grave = `${filePath}.${randomUUID()}.grave`
    try {
      await rename(filePath, grave)
    } catch {
      return false
    }
    const item = await this.readCacheFile(grave)
    const expired = item !== null && this.isExpired(item)
    if (!expired) await link(grave, filePath).catch(() => undefined)
    await unlink(grave).catch(() => undefined)
    return expired
  }

  getBasePath(): string {
    return this.basePath
  }
}
