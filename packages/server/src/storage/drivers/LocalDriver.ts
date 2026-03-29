import {
  readFile,
  writeFile,
  unlink,
  stat,
  readdir,
  mkdir,
  rm,
  copyFile,
  rename,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import type { StorageDriver, LocalDriverOptions, PutOptions, FileMetadata } from '../types'

/**
 * Local filesystem storage driver.
 *
 * @example
 * ```ts
 * const driver = new LocalDriver({
 *   root: './storage/app',
 *   url: '/storage',
 * })
 *
 * await driver.put('avatars/user-1.jpg', imageBuffer)
 * const url = driver.url('avatars/user-1.jpg')
 * ```
 */
export class LocalDriver implements StorageDriver {
  private readonly root: string
  private readonly baseUrl: string
  private readonly defaultVisibility: 'public' | 'private'

  constructor(options: LocalDriverOptions) {
    this.root = options.root
    this.baseUrl = options.url ?? ''
    this.defaultVisibility = options.visibility ?? 'private'
  }

  /**
   * Get the full path for a file.
   */
  private fullPath(path: string): string {
    return join(this.root, path)
  }

  /**
   * Ensure the directory exists.
   */
  private async ensureDirectory(filePath: string): Promise<void> {
    const dir = dirname(filePath)
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }
  }

  async put(path: string, content: Buffer | string, options?: PutOptions): Promise<string> {
    const fullPath = this.fullPath(path)
    await this.ensureDirectory(fullPath)

    const buffer = typeof content === 'string' ? Buffer.from(content) : content
    await writeFile(fullPath, buffer)

    return path
  }

  async putFile(path: string, localPath: string, options?: PutOptions): Promise<string> {
    const content = await readFile(localPath)
    return this.put(path, content, options)
  }

  async get(path: string): Promise<Buffer | null> {
    const fullPath = this.fullPath(path)

    try {
      return await readFile(fullPath)
    } catch {
      return null
    }
  }

  async getAsString(path: string): Promise<string | null> {
    const content = await this.get(path)
    return content ? content.toString('utf-8') : null
  }

  async exists(path: string): Promise<boolean> {
    return existsSync(this.fullPath(path))
  }

  async delete(path: string): Promise<boolean> {
    const fullPath = this.fullPath(path)

    try {
      await unlink(fullPath)
      return true
    } catch {
      return false
    }
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
    const fromPath = this.fullPath(from)
    const toPath = this.fullPath(to)

    await this.ensureDirectory(toPath)
    await copyFile(fromPath, toPath)

    return to
  }

  async move(from: string, to: string): Promise<string> {
    const fromPath = this.fullPath(from)
    const toPath = this.fullPath(to)

    await this.ensureDirectory(toPath)
    await rename(fromPath, toPath)

    return to
  }

  url(path: string): string {
    return `${this.baseUrl}/${path}`
  }

  async temporaryUrl(path: string, expiration: Date): Promise<string> {
    // Local driver doesn't support temporary URLs
    // Return the regular URL
    return this.url(path)
  }

  async size(path: string): Promise<number> {
    const fullPath = this.fullPath(path)
    const stats = await stat(fullPath)
    return stats.size
  }

  async lastModified(path: string): Promise<Date> {
    const fullPath = this.fullPath(path)
    const stats = await stat(fullPath)
    return stats.mtime
  }

  async metadata(path: string): Promise<FileMetadata | null> {
    const fullPath = this.fullPath(path)

    try {
      const stats = await stat(fullPath)
      return {
        path,
        size: stats.size,
        lastModified: stats.mtime,
        visibility: this.defaultVisibility,
      }
    } catch {
      return null
    }
  }

  async files(directory: string): Promise<string[]> {
    const fullPath = this.fullPath(directory)

    if (!existsSync(fullPath)) {
      return []
    }

    const entries = await readdir(fullPath, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(directory, entry.name))
  }

  async directories(directory: string): Promise<string[]> {
    const fullPath = this.fullPath(directory)

    if (!existsSync(fullPath)) {
      return []
    }

    const entries = await readdir(fullPath, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name))
  }

  async allFiles(directory: string): Promise<string[]> {
    const files: string[] = []

    const scan = async (dir: string): Promise<void> => {
      const fullPath = this.fullPath(dir)

      if (!existsSync(fullPath)) {
        return
      }

      const entries = await readdir(fullPath, { withFileTypes: true })

      for (const entry of entries) {
        const entryPath = join(dir, entry.name)
        if (entry.isFile()) {
          files.push(entryPath)
        } else if (entry.isDirectory()) {
          await scan(entryPath)
        }
      }
    }

    await scan(directory)
    return files
  }

  async makeDirectory(path: string): Promise<void> {
    const fullPath = this.fullPath(path)
    await mkdir(fullPath, { recursive: true })
  }

  async deleteDirectory(path: string): Promise<void> {
    const fullPath = this.fullPath(path)

    if (existsSync(fullPath)) {
      await rm(fullPath, { recursive: true, force: true })
    }
  }

  async setVisibility(path: string, visibility: 'public' | 'private'): Promise<void> {
    // Local driver doesn't have visibility control
    // This is a no-op
  }

  async getVisibility(path: string): Promise<'public' | 'private'> {
    return this.defaultVisibility
  }

  /**
   * Get the root directory.
   */
  getRoot(): string {
    return this.root
  }
}
