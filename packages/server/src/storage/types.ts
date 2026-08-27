/**
 * Options for putting files.
 */
export interface PutOptions {
  /**
   * File visibility.
   */
  visibility?: 'public' | 'private'

  /**
   * Content type (MIME type).
   */
  contentType?: string

  /**
   * Custom metadata.
   */
  metadata?: Record<string, string>
}

/**
 * File metadata.
 */
export interface FileMetadata {
  /**
   * File path.
   */
  path: string

  /**
   * File size in bytes.
   */
  size: number

  /**
   * Last modified date.
   */
  lastModified: Date

  /**
   * Content type (if available).
   */
  contentType?: string

  /**
   * File visibility.
   */
  visibility?: 'public' | 'private'

  /**
   * Custom metadata.
   */
  metadata?: Record<string, string>
}

/**
 * Response-override options for temporary (presigned) URLs — RFC 0015 §3.
 *
 * Drivers that presign map these onto the backend's `response-*` overrides
 * (S3: `ResponseContentDisposition` / `ResponseContentType` on the presigned
 * `GetObjectCommand`) so Content-Disposition and Content-Type policy
 * survives a redirect to the bucket. A driver that cannot honour them
 * ignores them and serves its own object metadata — a caller that needs the
 * guarantee must proxy the bytes instead.
 */
export interface TemporaryUrlOptions {
  responseContentDisposition?: string
  responseContentType?: string
}

/**
 * Streaming-read options. `range` is byte-inclusive (`start`..`end`, `end`
 * omitted = to end of file), matching HTTP Range semantics.
 */
export interface GetStreamOptions {
  range?: { start: number; end?: number }
}

/**
 * Capabilities a driver positively declares — RFC 0015 §3. Absent means
 * none: a capability not declared is treated as unavailable (fail-closed),
 * never probed. Probing cannot work here: `LocalDriver.temporaryUrl()`
 * succeeds and returns a plain public URL, so a try/catch probe would
 * misclassify exactly the disk that must not redirect.
 */
export interface StorageDriverCapabilities {
  /**
   * `temporaryUrl()` returns a URL whose bearer-signature the backend
   * itself enforces (S3-style presign) — not merely a URL. `LocalDriver`
   * must NOT declare this: its `temporaryUrl()` is the plain public URL.
   */
  presignedGet?: boolean
}

/**
 * Storage driver interface.
 */
export interface StorageDriver {
  /**
   * Capabilities the delivery layer may rely on. Absent ⇒ none declared.
   */
  readonly capabilities?: StorageDriverCapabilities

  /**
   * Put a file into storage.
   * @param path File path
   * @param content File content
   * @param options Put options
   * @returns The stored file path
   */
  put(path: string, content: Buffer | string, options?: PutOptions): Promise<string>

  /**
   * Put a file from a local path.
   * @param path Destination path
   * @param localPath Local file path
   * @param options Put options
   * @returns The stored file path
   */
  putFile(path: string, localPath: string, options?: PutOptions): Promise<string>

  /**
   * Get file contents.
   * @param path File path
   * @returns File contents or null if not found
   */
  get(path: string): Promise<Buffer | null>

  /**
   * Get file contents as string.
   * @param path File path
   * @returns File contents as string or null if not found
   */
  getAsString(path: string): Promise<string | null>

  /**
   * Check if a file exists.
   * @param path File path
   */
  exists(path: string): Promise<boolean>

  /**
   * Delete a file.
   * @param path File path
   * @returns True if deleted, false if not found
   */
  delete(path: string): Promise<boolean>

  /**
   * Delete multiple files.
   * @param paths File paths
   * @returns Number of deleted files
   */
  deleteMany(paths: string[]): Promise<number>

  /**
   * Copy a file.
   * @param from Source path
   * @param to Destination path
   * @returns The destination path
   */
  copy(from: string, to: string): Promise<string>

  /**
   * Move a file.
   * @param from Source path
   * @param to Destination path
   * @returns The destination path
   */
  move(from: string, to: string): Promise<string>

  /**
   * Get the public URL for a file.
   * @param path File path
   */
  url(path: string): string

  /**
   * Get a temporary (signed) URL for a file.
   * @param path File path
   * @param expiration Expiration date
   * @param options Response overrides for presigning drivers (ignored by
   *                drivers that cannot honour them — see TemporaryUrlOptions)
   */
  temporaryUrl(path: string, expiration: Date, options?: TemporaryUrlOptions): Promise<string>

  /**
   * Read a file as a stream. Optional — callers fall back to buffered
   * `get()` where absent.
   *
   * Contract: resolves `null` for a missing file, verified *before* the
   * stream is returned (a stream whose open fails after return cannot
   * honour that), and the result is normalized to the global web
   * `ReadableStream` at the driver's own boundary (`Readable.toWeb`,
   * `Body.transformToWebStream()`, or a cast where the runtime's stream
   * type is structurally compatible).
   *
   * @param path File path
   * @param options Optional byte range
   */
  getStream?(path: string, options?: GetStreamOptions): Promise<ReadableStream<Uint8Array> | null>

  /**
   * Get the file size in bytes.
   * @param path File path
   */
  size(path: string): Promise<number>

  /**
   * Get the last modified date.
   * @param path File path
   */
  lastModified(path: string): Promise<Date>

  /**
   * Get file metadata.
   * @param path File path
   */
  metadata(path: string): Promise<FileMetadata | null>

  /**
   * List files in a directory.
   * @param directory Directory path
   */
  files(directory: string): Promise<string[]>

  /**
   * List subdirectories in a directory.
   * @param directory Directory path
   */
  directories(directory: string): Promise<string[]>

  /**
   * List all files recursively.
   * @param directory Directory path
   */
  allFiles(directory: string): Promise<string[]>

  /**
   * Create a directory.
   * @param path Directory path
   */
  makeDirectory(path: string): Promise<void>

  /**
   * Delete a directory and its contents.
   * @param path Directory path
   */
  deleteDirectory(path: string): Promise<void>

  /**
   * Set file visibility.
   *
   * Contract: throws when the file does not exist, so a caller cannot take
   * success as proof the object is there. A driver whose backend has no
   * per-object visibility (bucket-level access, a plain filesystem) reports
   * the disk's configured visibility and throws when asked for the other
   * value, rather than accepting a request it cannot honour — silently
   * doing nothing is a leak that looks like success.
   *
   * `LocalDriver` is such a backend: what makes a local file reachable is
   * the disk root and whatever serves it, not a flag on one file. It has
   * always accepted per-object requests and done nothing, so it warns
   * instead of throwing and will throw in the next major.
   *
   * @param path File path
   * @param visibility Visibility setting
   */
  setVisibility(path: string, visibility: 'public' | 'private'): Promise<void>

  /**
   * Get file visibility.
   *
   * Contract: throws when the file does not exist. Drivers without
   * per-object visibility report the disk's configured value.
   *
   * @param path File path
   */
  getVisibility(path: string): Promise<'public' | 'private'>
}

/**
 * Storage driver factory function.
 */
export type StorageDriverFactory = () => StorageDriver

/**
 * Local driver options.
 */
export interface LocalDriverOptions {
  /**
   * Root directory for file storage.
   */
  root: string

  /**
   * Base URL for public files.
   */
  url?: string

  /**
   * Default visibility for new files.
   * @default 'private'
   */
  visibility?: 'public' | 'private'
}

/**
 * S3 driver options.
 */
export interface S3DriverOptions {
  /**
   * S3 client instance (@aws-sdk/client-s3).
   */
  client?: unknown

  /**
   * S3 bucket name.
   */
  bucket: string

  /**
   * AWS region.
   */
  region?: string

  /**
   * Custom endpoint URL.
   */
  endpoint?: string

  /**
   * Access key ID.
   */
  accessKeyId?: string

  /**
   * Secret access key.
   */
  secretAccessKey?: string

  /**
   * Key prefix.
   */
  prefix?: string

  /**
   * Base URL for public files.
   */
  url?: string

  /**
   * Default visibility for new files.
   * @default 'private'
   */
  visibility?: 'public' | 'private'

  /**
   * Whether the endpoint implements S3 object ACLs.
   *
   * AWS S3 does, so this defaults to `true` and every `put` carries an
   * `x-amz-acl` header derived from the file's visibility. Several
   * S3-compatible endpoints do not: Cloudflare R2 documents `x-amz-acl` and
   * the ACL operations as unsupported (access is decided per bucket), and
   * MinIO/others vary. Set `acl: false` for those.
   *
   * With `acl: false` the driver stops sending the header, and visibility
   * becomes a property of the whole disk: `getVisibility()` reports the
   * configured `visibility`, and `put({ visibility })` / `setVisibility()`
   * throw when asked for the other value rather than silently not applying
   * it. Enforce per-object access in front of the disk instead.
   *
   * @default true
   */
  acl?: boolean
}

/**
 * Memory driver options.
 */
export interface MemoryDriverOptions {
  /**
   * Base URL for public files.
   */
  url?: string
}

/**
 * Driver configuration union type.
 */
export type DriverConfig =
  | ({ driver: 'local' } & LocalDriverOptions)
  | ({ driver: 's3' } & S3DriverOptions)
  | ({ driver: 'memory' } & MemoryDriverOptions)

export type DiskConfig = DriverConfig

/**
 * Storage configuration.
 */
export interface StorageConfig {
  /**
   * Default disk name.
   * @default 'local'
   */
  default?: string

  /**
   * Disk configurations.
   */
  disks?: Record<string, DriverConfig>
}
