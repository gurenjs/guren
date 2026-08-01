import type { StorageDriver, MemoryDriverOptions, PutOptions, FileMetadata } from '../types'
import { trimSlashes } from '../../support/trim-slashes'

/**
 * Stored file in memory.
 */
interface StoredFile {
  content: Buffer
  contentType?: string
  visibility: 'public' | 'private'
  metadata?: Record<string, string>
  lastModified: Date
}

/**
 * In-memory storage driver for testing.
 *
 * @example
 * ```ts
 * const driver = new MemoryDriver()
 *
 * await driver.put('avatars/user-1.jpg', imageBuffer)
 * const content = await driver.get('avatars/user-1.jpg')
 * ```
 */
export class MemoryDriver implements StorageDriver {
  private readonly storage: Map<string, StoredFile> = new Map()
  private readonly baseUrl: string

  constructor(options: MemoryDriverOptions = {}) {
    this.baseUrl = options.url ?? 'memory://'
  }

  /**
   * Normalize path (remove leading/trailing slashes).
   */
  private normalizePath(path: string): string {
    return trimSlashes(path)
  }

  /**
   * Get directory from path.
   */
  private getDirectory(path: string): string {
    const parts = path.split('/')
    return parts.slice(0, -1).join('/')
  }

  /**
   * Check if a path is in a directory.
   */
  private isInDirectory(filePath: string, directory: string): boolean {
    const normalized = this.normalizePath(filePath)
    const normalizedDir = this.normalizePath(directory)

    if (!normalizedDir) {
      return !normalized.includes('/')
    }

    return normalized.startsWith(normalizedDir + '/') &&
      !normalized.slice(normalizedDir.length + 1).includes('/')
  }

  /**
   * Check if a path is under a directory (recursive).
   */
  private isUnderDirectory(filePath: string, directory: string): boolean {
    const normalized = this.normalizePath(filePath)
    const normalizedDir = this.normalizePath(directory)

    if (!normalizedDir) {
      return true
    }

    return normalized.startsWith(normalizedDir + '/')
  }

  async put(path: string, content: Buffer | string, options?: PutOptions): Promise<string> {
    const normalized = this.normalizePath(path)
    const buffer = typeof content === 'string' ? Buffer.from(content) : content

    this.storage.set(normalized, {
      content: buffer,
      contentType: options?.contentType,
      visibility: options?.visibility ?? 'private',
      metadata: options?.metadata,
      lastModified: new Date(),
    })

    return normalized
  }

  async putFile(path: string, localPath: string, options?: PutOptions): Promise<string> {
    // In memory driver, we can't read local files
    throw new Error('putFile is not supported in MemoryDriver')
  }

  async get(path: string): Promise<Buffer | null> {
    const normalized = this.normalizePath(path)
    const file = this.storage.get(normalized)
    return file?.content ?? null
  }

  async getAsString(path: string): Promise<string | null> {
    const content = await this.get(path)
    return content ? content.toString('utf-8') : null
  }

  async exists(path: string): Promise<boolean> {
    const normalized = this.normalizePath(path)
    return this.storage.has(normalized)
  }

  async delete(path: string): Promise<boolean> {
    const normalized = this.normalizePath(path)
    return this.storage.delete(normalized)
  }

  async deleteMany(paths: string[]): Promise<number> {
    let deleted = 0

    for (const path of paths) {
      if (await this.delete(path)) {
        deleted++
      }
    }

    return deleted
  }

  async copy(from: string, to: string): Promise<string> {
    const normalizedFrom = this.normalizePath(from)
    const normalizedTo = this.normalizePath(to)

    const file = this.storage.get(normalizedFrom)
    if (!file) {
      throw new Error(`File not found: ${from}`)
    }

    this.storage.set(normalizedTo, {
      ...file,
      content: Buffer.from(file.content),
      lastModified: new Date(),
    })

    return normalizedTo
  }

  async move(from: string, to: string): Promise<string> {
    await this.copy(from, to)
    await this.delete(from)
    return this.normalizePath(to)
  }

  url(path: string): string {
    const normalized = this.normalizePath(path)
    return `${this.baseUrl}/${normalized}`
  }

  async temporaryUrl(path: string, expiration: Date): Promise<string> {
    // Memory driver doesn't support temporary URLs
    return this.url(path)
  }

  async size(path: string): Promise<number> {
    const normalized = this.normalizePath(path)
    const file = this.storage.get(normalized)

    if (!file) {
      throw new Error(`File not found: ${path}`)
    }

    return file.content.length
  }

  async lastModified(path: string): Promise<Date> {
    const normalized = this.normalizePath(path)
    const file = this.storage.get(normalized)

    if (!file) {
      throw new Error(`File not found: ${path}`)
    }

    return file.lastModified
  }

  async metadata(path: string): Promise<FileMetadata | null> {
    const normalized = this.normalizePath(path)
    const file = this.storage.get(normalized)

    if (!file) {
      return null
    }

    return {
      path: normalized,
      size: file.content.length,
      lastModified: file.lastModified,
      contentType: file.contentType,
      visibility: file.visibility,
      metadata: file.metadata,
    }
  }

  async files(directory: string): Promise<string[]> {
    const normalized = this.normalizePath(directory)
    const result: string[] = []

    for (const path of this.storage.keys()) {
      if (this.isInDirectory(path, normalized)) {
        result.push(path)
      }
    }

    return result.sort()
  }

  async directories(directory: string): Promise<string[]> {
    const normalized = this.normalizePath(directory)
    const dirs = new Set<string>()

    for (const path of this.storage.keys()) {
      if (this.isUnderDirectory(path, normalized)) {
        const relativePath = normalized ? path.slice(normalized.length + 1) : path
        const firstDir = relativePath.split('/')[0]
        if (relativePath.includes('/')) {
          dirs.add(normalized ? `${normalized}/${firstDir}` : firstDir)
        }
      }
    }

    return Array.from(dirs).sort()
  }

  async allFiles(directory: string): Promise<string[]> {
    const normalized = this.normalizePath(directory)
    const result: string[] = []

    for (const path of this.storage.keys()) {
      if (this.isUnderDirectory(path, normalized)) {
        result.push(path)
      }
    }

    return result.sort()
  }

  async makeDirectory(path: string): Promise<void> {
    // Memory driver doesn't need to create directories
    // Files are stored by path directly
  }

  async deleteDirectory(path: string): Promise<void> {
    const normalized = this.normalizePath(path)
    const keysToDelete: string[] = []

    for (const key of this.storage.keys()) {
      if (this.isUnderDirectory(key, normalized)) {
        keysToDelete.push(key)
      }
    }

    for (const key of keysToDelete) {
      this.storage.delete(key)
    }
  }

  async setVisibility(path: string, visibility: 'public' | 'private'): Promise<void> {
    const normalized = this.normalizePath(path)
    const file = this.storage.get(normalized)

    if (!file) {
      throw new Error(`File not found: ${path}`)
    }

    file.visibility = visibility
  }

  async getVisibility(path: string): Promise<'public' | 'private'> {
    const normalized = this.normalizePath(path)
    const file = this.storage.get(normalized)

    if (!file) {
      throw new Error(`File not found: ${path}`)
    }

    return file.visibility
  }

  /**
   * Clear all files (for testing).
   */
  clear(): void {
    this.storage.clear()
  }

  /**
   * Get the number of stored files.
   */
  count(): number {
    return this.storage.size
  }

  /**
   * Get all stored file paths.
   */
  getAllPaths(): string[] {
    return Array.from(this.storage.keys())
  }
}
