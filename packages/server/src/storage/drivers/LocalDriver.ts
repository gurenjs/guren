import {
  readFile,
  lstat,
  readlink,
  realpath,
  writeFile,
  unlink,
  stat,
  readdir,
  mkdir,
  rm,
  copyFile,
  rename,
  open,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import { join, dirname, resolve, relative, sep } from 'node:path'
import type { StorageDriver, LocalDriverOptions, PutOptions, FileMetadata, GetStreamOptions } from '../types'
import { isPathWithin, realPathOfNearestExisting } from '../../support/contained-path'
import { warnOnce } from '../../support/warn-once'

export class LocalDriver implements StorageDriver {
  private readonly root: string
  private readonly baseUrl: string
  private readonly defaultVisibility: 'public' | 'private'
  private resolvedRoot?: Promise<string>

  constructor(options: LocalDriverOptions) {
    this.root = options.root
    this.baseUrl = options.url ?? ''
    this.defaultVisibility = options.visibility ?? 'private'
  }

  private async fullPath(path: string): Promise<string> {
    const root = resolve(this.root)
    const candidate = resolve(root, path)
    if (candidate !== root && !isPathWithin(root, candidate)) {
      throw new Error(`LocalDriver: path escapes the storage root: "${path}"`)
    }
    await this.assertNoEscapingLink(root, candidate, path)
    return candidate
  }

  /**
   * `resolve()` collapses `..` without following links, so the lexical check
   * above still accepts `<root>/link/secret`, and every reader below follows
   * the link. Each component is resolved instead of refused: a link that stays
   * inside the disk is legitimate. One resolution per component is enough,
   * since `realPathOfNearestExisting()` returns a path holding no further link.
   */
  private async assertNoEscapingLink(root: string, candidate: string, path: string): Promise<void> {
    const realRoot = await this.canonicalRoot()
    if (realRoot === undefined) return

    let current = realRoot
    for (const part of relative(root, candidate).split(sep).filter(Boolean)) {
      current = join(current, part)

      let link: string
      try {
        if (!(await lstat(current)).isSymbolicLink()) continue
        link = await readlink(current)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        // Nothing exists here, so nothing deeper does either.
        if (code === 'ENOENT' || code === 'ENOTDIR') return
        throw error
      }

      const target = await realPathOfNearestExisting(resolve(dirname(current), link))
      if (target === undefined) {
        throw new Error(`LocalDriver: cannot resolve a symbolic link in the path: "${path}"`)
      }
      if (target !== realRoot && !isPathWithin(realRoot, target)) {
        throw new Error(`LocalDriver: path escapes the storage root through a symbolic link: "${path}"`)
      }
      current = target
    }
  }

  /**
   * Memoized: the root is fixed for the driver's lifetime and re-resolving it
   * costs a third of an operation's syscalls. A disk whose root does not exist
   * yet caches nothing, so the guard starts once the root is created.
   */
  private async canonicalRoot(): Promise<string | undefined> {
    this.resolvedRoot ??= realpath(resolve(this.root))

    try {
      return await this.resolvedRoot
    } catch (error) {
      this.resolvedRoot = undefined
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async ensureDirectory(filePath: string): Promise<void> {
    const dir = dirname(filePath)
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }
  }

  async put(path: string, content: Buffer | string, options?: PutOptions): Promise<string> {
    if (options?.visibility) {
      this.warnUnsupportedVisibility(options.visibility, 'put')
    }
    const fullPath = await this.fullPath(path)
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
    const fullPath = await this.fullPath(path)

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

  async getStream(path: string, options?: GetStreamOptions): Promise<ReadableStream<Uint8Array> | null> {
    const fullPath = await this.fullPath(path)

    // A bare createReadStream() fails its open asynchronously, which cannot
    // honour the contract's `null` for a missing file.
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(fullPath, 'r')
    } catch {
      return null
    }

    const stats = await handle.stat()
    if (!stats.isFile()) {
      await handle.close()
      return null
    }

    // autoClose (default) closes the handle when the stream ends or errors.
    const nodeStream = handle.createReadStream(
      options?.range ? { start: options.range.start, end: options.range.end } : undefined,
    )
    // node:stream/web's ReadableStream is a distinct type from the global one
    // for the same runtime object; normalize at this boundary.
    return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>
  }

  async exists(path: string): Promise<boolean> {
    return existsSync(await this.fullPath(path))
  }

  async delete(path: string): Promise<boolean> {
    const fullPath = await this.fullPath(path)

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
    const fromPath = await this.fullPath(from)
    const toPath = await this.fullPath(to)

    await this.ensureDirectory(toPath)
    await copyFile(fromPath, toPath)

    return to
  }

  async move(from: string, to: string): Promise<string> {
    const fromPath = await this.fullPath(from)
    const toPath = await this.fullPath(to)

    await this.ensureDirectory(toPath)
    await rename(fromPath, toPath)

    return to
  }

  url(path: string): string {
    return `${this.baseUrl}/${path}`
  }

  async temporaryUrl(path: string, _expiration: Date): Promise<string> {
    // Local driver doesn't support temporary URLs
    return this.url(path)
  }

  async size(path: string): Promise<number> {
    const fullPath = await this.fullPath(path)
    const stats = await stat(fullPath)
    return stats.size
  }

  async lastModified(path: string): Promise<Date> {
    const fullPath = await this.fullPath(path)
    const stats = await stat(fullPath)
    return stats.mtime
  }

  async metadata(path: string): Promise<FileMetadata | null> {
    const fullPath = await this.fullPath(path)

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
    const fullPath = await this.fullPath(directory)

    if (!existsSync(fullPath)) {
      return []
    }

    const entries = await readdir(fullPath, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(directory, entry.name))
  }

  async directories(directory: string): Promise<string[]> {
    const fullPath = await this.fullPath(directory)

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

    // The full path is carried down rather than re-derived: validating it
    // re-walks every ancestor, and `isDirectory()` is false for a link, so
    // recursion never enters one.
    const scan = async (dir: string, fullPath: string): Promise<void> => {
      if (!existsSync(fullPath)) {
        return
      }

      const entries = await readdir(fullPath, { withFileTypes: true })

      for (const entry of entries) {
        const entryPath = join(dir, entry.name)
        if (entry.isFile()) {
          files.push(entryPath)
        } else if (entry.isDirectory()) {
          await scan(entryPath, join(fullPath, entry.name))
        }
      }
    }

    await scan(directory, await this.fullPath(directory))
    return files
  }

  async makeDirectory(path: string): Promise<void> {
    const fullPath = await this.fullPath(path)
    await mkdir(fullPath, { recursive: true })
  }

  async deleteDirectory(path: string): Promise<void> {
    const fullPath = await this.fullPath(path)

    if (existsSync(fullPath)) {
      await rm(fullPath, { recursive: true, force: true })
    }
  }

  async setVisibility(path: string, visibility: 'public' | 'private'): Promise<void> {
    // A local disk has no per-object visibility: reachability is decided by
    // the disk root and what serves it. The contract says to refuse what
    // cannot be carried out; this driver warns for now, throws in the next major.
    await this.warnIfMissing(path, 'setVisibility')
    this.warnUnsupportedVisibility(visibility, 'setVisibility')
  }

  async getVisibility(path: string): Promise<'public' | 'private'> {
    await this.warnIfMissing(path, 'getVisibility')
    return this.defaultVisibility
  }

  private async warnIfMissing(path: string, operation: string): Promise<void> {
    if (await this.exists(path)) {
      return
    }
    warnOnce(
      `local-visibility-missing:${operation}`,
      `[guren] LocalDriver.${operation}("${path}") was called for a file that does not exist and returned as if it `
        + 'had succeeded. Every other storage driver throws `File not found` here, and LocalDriver will too in the '
        + 'next major — check `exists()` first, or handle the error.',
    )
  }

  private warnUnsupportedVisibility(requested: 'public' | 'private', operation: string): void {
    if (requested === this.defaultVisibility) {
      return
    }
    warnOnce(
      `local-visibility-per-object:${operation}`,
      `[guren] LocalDriver.${operation}() was asked to make an object ${requested} on a ${this.defaultVisibility} `
        + 'disk, and did nothing. A local disk has no per-object visibility — what makes a file reachable is the '
        + 'disk root and whatever serves it — so the request was never carried out, it only looked like it was. '
        + 'Declare the disk\'s "visibility" option to match, or keep restricted files on a disk that is not '
        + 'served. This becomes an error in the next major.',
    )
  }

  getRoot(): string {
    return this.root
  }
}
