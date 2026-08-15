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
 * Storage driver interface.
 */
export interface StorageDriver {
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
   */
  temporaryUrl(path: string, expiration: Date): Promise<string>

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
   * Known deviation: `LocalDriver` is an unconditional no-op and does not
   * throw on either count. Aligning it changes the default behavior of a
   * stable API, so it is deferred to the next major.
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
   * Known deviation: `LocalDriver` returns the disk value for any path,
   * including one that does not exist (see `setVisibility`).
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
