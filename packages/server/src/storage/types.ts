export interface PutOptions {
  visibility?: 'public' | 'private'

  contentType?: string

  metadata?: Record<string, string>
}

export interface FileMetadata {
  path: string

  /** Size in bytes. */
  size: number

  lastModified: Date

  contentType?: string

  visibility?: 'public' | 'private'

  metadata?: Record<string, string>
}

/**
 * Response overrides for presigned URLs — RFC 0015 §3. A driver that cannot
 * honour them ignores them and serves its own object metadata; a caller that
 * needs the guarantee must proxy the bytes instead.
 */
export interface TemporaryUrlOptions {
  responseContentDisposition?: string
  responseContentType?: string
}

/** `range` is byte-inclusive, `end` omitted = to end of file (HTTP Range semantics). */
export interface GetStreamOptions {
  range?: { start: number; end?: number }
}

/**
 * Capabilities a driver positively declares — RFC 0015 §3. Absent means
 * unavailable (fail-closed), never probed: `LocalDriver.temporaryUrl()`
 * succeeds and returns a plain public URL, so a probe would misclassify
 * exactly the disk that must not redirect.
 */
export interface StorageDriverCapabilities {
  /**
   * URL whose signature the backend itself enforces (S3-style presign), not
   * merely a URL. `LocalDriver` must NOT declare this.
   */
  presignedGet?: boolean
}

export interface StorageDriver {
  readonly capabilities?: StorageDriverCapabilities

  put(path: string, content: Buffer | string, options?: PutOptions): Promise<string>

  putFile(path: string, localPath: string, options?: PutOptions): Promise<string>

  get(path: string): Promise<Buffer | null>

  getAsString(path: string): Promise<string | null>

  exists(path: string): Promise<boolean>

  /** Resolves false when the file did not exist. */
  delete(path: string): Promise<boolean>

  deleteMany(paths: string[]): Promise<number>

  copy(from: string, to: string): Promise<string>

  move(from: string, to: string): Promise<string>

  url(path: string): string

  temporaryUrl(path: string, expiration: Date, options?: TemporaryUrlOptions): Promise<string>

  /**
   * Optional — callers fall back to buffered `get()` where absent. Resolves
   * `null` for a missing file, verified *before* the stream is returned, and
   * normalizes the result to the global web `ReadableStream`.
   */
  getStream?(path: string, options?: GetStreamOptions): Promise<ReadableStream<Uint8Array> | null>

  size(path: string): Promise<number>

  lastModified(path: string): Promise<Date>

  metadata(path: string): Promise<FileMetadata | null>

  files(directory: string): Promise<string[]>

  directories(directory: string): Promise<string[]>

  allFiles(directory: string): Promise<string[]>

  makeDirectory(path: string): Promise<void>

  deleteDirectory(path: string): Promise<void>

  /**
   * Throws when the file does not exist, so success is not proof the object is
   * there. A driver with no per-object visibility reports the disk's configured
   * value and throws when asked for the other one: silently doing nothing is a
   * leak that looks like success. `LocalDriver` is such a backend, and warns
   * today rather than throwing only because it has always accepted these.
   */
  setVisibility(path: string, visibility: 'public' | 'private'): Promise<void>

  /**
   * Throws when the file does not exist. Drivers without per-object visibility
   * report the disk's configured value.
   */
  getVisibility(path: string): Promise<'public' | 'private'>
}

export type StorageDriverFactory = () => StorageDriver

export interface LocalDriverOptions {
  root: string

  url?: string

  /** @default 'private' */
  visibility?: 'public' | 'private'
}

export interface S3DriverOptions {
  client?: unknown

  bucket: string

  region?: string

  endpoint?: string

  accessKeyId?: string

  secretAccessKey?: string

  prefix?: string

  url?: string

  /** @default 'private' */
  visibility?: 'public' | 'private'

  /**
   * AWS S3 implements object ACLs, so every `put` carries `x-amz-acl` derived
   * from visibility. Cloudflare R2 documents it as unsupported and MinIO/others
   * vary: set `acl: false` there, which makes visibility a property of the whole
   * disk and turns a mismatched `put`/`setVisibility` into a throw.
   * @default true
   */
  acl?: boolean
}

export interface MemoryDriverOptions {
  url?: string
}

export type DriverConfig =
  | ({ driver: 'local' } & LocalDriverOptions)
  | ({ driver: 's3' } & S3DriverOptions)
  | ({ driver: 'memory' } & MemoryDriverOptions)

export type DiskConfig = DriverConfig

export interface StorageConfig {
  default?: string

  disks?: Record<string, DriverConfig>
}
