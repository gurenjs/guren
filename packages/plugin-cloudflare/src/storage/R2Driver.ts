import type { FileMetadata, PutOptions, StorageDriver } from '@guren/core'

/**
 * Structural view of the R2 binding, in the same spirit as the S3 driver's
 * local `S3Client { send() }`: only what this driver calls, so
 * `@cloudflare/workers-types` stays a devDependency. `R2Driver.types.test.ts`
 * pins that the real `R2Bucket` satisfies it.
 */
export interface R2HttpMetadataLike {
  contentType?: string
  contentLanguage?: string
  contentDisposition?: string
  contentEncoding?: string
  cacheControl?: string
  cacheExpiry?: Date
}

export interface R2ObjectLike {
  key: string
  size: number
  uploaded: Date
  etag: string
  httpEtag: string
  httpMetadata?: R2HttpMetadataLike
  customMetadata?: Record<string, string>
}

/**
 * Streams and blobs are typed structurally rather than as the global
 * `ReadableStream`/`Blob`: `@cloudflare/workers-types` declares its own
 * interfaces for both, and neither direction is assignable to the runtime
 * globals, so naming the globals here would make the real `R2Bucket` fail
 * the `R2BucketLike` check while being perfectly usable at runtime.
 */
export interface R2StreamLike {
  locked: boolean
  getReader(): unknown
  cancel(reason?: unknown): Promise<void>
}

export interface R2BlobLike {
  size: number
  type: string
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  body: R2StreamLike
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
}

export interface R2ObjectsLike {
  objects: R2ObjectLike[]
  truncated: boolean
  cursor?: string
  delimitedPrefixes: string[]
}

export interface R2ListOptionsLike {
  prefix?: string
  delimiter?: string
  cursor?: string
  limit?: number
}

export interface R2PutOptionsLike {
  httpMetadata?: R2HttpMetadataLike
  customMetadata?: Record<string, string>
}

export type R2PutValue = R2StreamLike | R2BlobLike | ArrayBuffer | ArrayBufferView | string | null

export interface R2BucketLike {
  head(key: string): Promise<R2ObjectLike | null>
  get(key: string): Promise<R2ObjectBodyLike | null>
  put(key: string, value: R2PutValue, options?: R2PutOptionsLike): Promise<R2ObjectLike | null>
  delete(keys: string | string[]): Promise<void>
  list(options?: R2ListOptionsLike): Promise<R2ObjectsLike>
}

export interface R2PresignOptions {
  /** Cloudflare account id — the S3 endpoint is `https://<accountId>.r2.cloudflarestorage.com`. */
  accountId: string
  /** Bucket name as R2 knows it (the binding does not expose it). */
  bucket: string
  /** R2 API token credentials (S3-compatible access key pair). */
  accessKeyId: string
  secretAccessKey: string
}

export interface R2DriverOptions {
  /**
   * Resolver returning the R2 bucket binding. Bindings arrive with the first
   * request on Workers, so this must be a deferred closure, e.g.
   * `binding: () => getWorkersEnv<Env>().BUCKET` — the same contract as
   * `createD1Database({ binding })`.
   */
  binding: () => unknown
  /**
   * Base URL for `url()`: the bucket's custom domain (recommended) or its
   * r2.dev subdomain. R2 has no derivable default — unlike S3 there is no
   * `https://<bucket>.s3.<region>.amazonaws.com` — so `url()` throws with
   * guidance when this is unset.
   */
  publicUrl?: string
  /** Key prefix, same semantics as `S3DriverOptions.prefix`. */
  prefix?: string
  /**
   * The visibility every object in this bucket effectively has. R2 has no
   * per-object ACL: a bucket is public (custom domain / r2.dev) or it is not.
   * Defaults to `'public'` when `publicUrl` is set, `'private'` otherwise.
   * `put({ visibility })` and `setVisibility()` throw when asked for the
   * other value — the driver refuses to pretend it can enforce a per-object
   * flag it cannot.
   */
  visibility?: 'public' | 'private'
  /**
   * S3 API credentials used only by `temporaryUrl()`. Optional — omit it and
   * `temporaryUrl()` throws with guidance. Requires the optional `aws4fetch`
   * dependency.
   */
  presign?: R2PresignOptions
}

/** R2 rejects presigned URLs valid for longer than seven days. */
const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60
/** `R2Bucket.delete()` accepts at most this many keys per call. */
const DELETE_BATCH_SIZE = 1000

/**
 * Cloudflare R2 storage driver over the Workers binding.
 *
 * @example
 * ```ts
 * const storage = createStorageManager({ default: 'media' })
 * storage.registerDisk('media', () => new R2Driver({
 *   binding: () => getWorkersEnv<Env>().MEDIA,
 *   publicUrl: 'https://media.example.com',
 * }))
 * ```
 */
export class R2Driver implements StorageDriver {
  private readonly resolveBinding: () => unknown
  private readonly publicUrl?: string
  private readonly prefix: string
  private readonly diskVisibility: 'public' | 'private'
  private readonly presign?: R2PresignOptions

  constructor(options: R2DriverOptions) {
    this.resolveBinding = options.binding
    this.publicUrl = options.publicUrl ? trimTrailingSlashes(options.publicUrl) : undefined
    this.prefix = trimSlashes(options.prefix ?? '')
    this.diskVisibility = options.visibility ?? (options.publicUrl ? 'public' : 'private')
    this.presign = options.presign
  }

  private bucket(): R2BucketLike {
    const binding = this.resolveBinding()
    if (binding == null) {
      throw new Error(
        'R2Driver: the "binding" resolver returned no R2 bucket. On Workers this usually means it ran ' +
          'before the first request — defer access (e.g. binding: () => getWorkersEnv<Env>().BUCKET) and ' +
          'check the r2_buckets entry in wrangler.jsonc, e.g. ' +
          '"r2_buckets": [{ "binding": "BUCKET", "bucket_name": "my-app-media" }].',
      )
    }
    return binding as R2BucketLike
  }

  private key(path: string): string {
    const normalized = trimSlashes(path)
    if (!this.prefix) return normalized
    return normalized ? `${this.prefix}/${normalized}` : this.prefix
  }

  /** Inverse of `key()`: strips the prefix so listings return app-relative paths. */
  private unkey(key: string): string {
    return this.prefix && key.startsWith(`${this.prefix}/`) ? key.slice(this.prefix.length + 1) : key
  }

  private directoryPrefix(directory: string): string {
    const key = this.key(directory)
    return key ? `${key}/` : ''
  }

  private assertVisibility(requested: 'public' | 'private' | undefined, operation: string): void {
    if (requested && requested !== this.diskVisibility) {
      throw new Error(
        `R2Driver.${operation}: cannot make an object ${requested} on a ${this.diskVisibility} bucket. ` +
          'R2 has no per-object visibility — access is decided per bucket (custom domain / r2.dev). ' +
          `Declare the bucket’s visibility with the driver’s "visibility" option, or serve private files ` +
          'through a signed app route.',
      )
    }
  }

  async put(path: string, content: Buffer | string, options?: PutOptions): Promise<string> {
    this.assertVisibility(options?.visibility, 'put')
    const putOptions: R2PutOptionsLike = {}
    if (options?.contentType) putOptions.httpMetadata = { contentType: options.contentType }
    if (options?.metadata) putOptions.customMetadata = options.metadata
    await this.bucket().put(this.key(path), content, putOptions)
    return trimSlashes(path)
  }

  async putFile(_path: string, _localPath: string, _options?: PutOptions): Promise<string> {
    throw new Error(
      'R2Driver.putFile is not supported: Workers has no filesystem to read from. Read the file yourself and call put().',
    )
  }

  async get(path: string): Promise<Buffer | null> {
    const object = await this.bucket().get(this.key(path))
    if (!object) return null
    return Buffer.from(await object.arrayBuffer())
  }

  async getAsString(path: string): Promise<string | null> {
    const object = await this.bucket().get(this.key(path))
    return object ? object.text() : null
  }

  async exists(path: string): Promise<boolean> {
    return (await this.bucket().head(this.key(path))) !== null
  }

  async delete(path: string): Promise<boolean> {
    // R2Bucket.delete() is void and idempotent; the contract's "false when
    // missing" needs a head first (a Class B read — cheap).
    const bucket = this.bucket()
    const key = this.key(path)
    if ((await bucket.head(key)) === null) return false
    await bucket.delete(key)
    return true
  }

  async deleteMany(paths: string[]): Promise<number> {
    return this.deleteKeys(paths.map((path) => this.key(path)))
  }

  private async deleteKeys(rawKeys: string[]): Promise<number> {
    const keys = Array.from(new Set(rawKeys))
    if (keys.length === 0) return 0
    const bucket = this.bucket()
    for (let index = 0; index < keys.length; index += DELETE_BATCH_SIZE) {
      await bucket.delete(keys.slice(index, index + DELETE_BATCH_SIZE))
    }
    // R2 reports nothing per key; like S3's DeleteObjects, every requested
    // key counts as deleted.
    return keys.length
  }

  async copy(from: string, to: string): Promise<string> {
    // The binding has no copy: stream the body from one key into another,
    // carrying the metadata across.
    const bucket = this.bucket()
    const source = await bucket.get(this.key(from))
    if (!source) {
      throw new Error(`File not found: ${from}`)
    }
    const options: R2PutOptionsLike = {}
    if (source.httpMetadata) options.httpMetadata = source.httpMetadata
    if (source.customMetadata) options.customMetadata = source.customMetadata
    await bucket.put(this.key(to), source.body, options)
    return trimSlashes(to)
  }

  async move(from: string, to: string): Promise<string> {
    await this.copy(from, to)
    await this.bucket().delete(this.key(from))
    return trimSlashes(to)
  }

  url(path: string): string {
    if (!this.publicUrl) {
      throw new Error(
        'R2Driver.url() requires the "publicUrl" option (the bucket’s custom domain or r2.dev subdomain). ' +
          'R2 has no derivable public URL.',
      )
    }
    // Percent-encode per segment so keys with spaces or `#` produce a URL
    // that resolves; `/` stays a separator.
    return `${this.publicUrl}/${encodeKey(this.key(path))}`
  }

  async temporaryUrl(path: string, expiration: Date): Promise<string> {
    if (!this.presign) {
      throw new Error(
        'R2Driver.temporaryUrl() cannot sign URLs through the R2 binding. Either configure ' +
          '"presign: { accountId, bucket, accessKeyId, secretAccessKey }" (an R2 API token, used with the ' +
          'S3-compatible endpoint) or serve private files through a signed app route.',
      )
    }
    const expiresIn = Math.floor((expiration.getTime() - Date.now()) / 1000)
    if (expiresIn > MAX_PRESIGN_SECONDS) {
      throw new Error(
        `R2Driver.temporaryUrl(): R2 presigned URLs may be valid for at most 7 days (requested ${expiresIn}s).`,
      )
    }
    const { AwsClient } = await importOptionalModule<{
      AwsClient: new (init: { accessKeyId: string; secretAccessKey: string; service: string; region: string }) => {
        sign(input: Request, init?: { aws?: { signQuery?: boolean } }): Promise<Request>
      }
    }>('aws4fetch')

    const client = new AwsClient({
      accessKeyId: this.presign.accessKeyId,
      secretAccessKey: this.presign.secretAccessKey,
      service: 's3',
      region: 'auto',
    })
    const url = new URL(
      `https://${this.presign.accountId}.r2.cloudflarestorage.com/${this.presign.bucket}/${encodeKey(this.key(path))}`,
    )
    url.searchParams.set('X-Amz-Expires', String(Math.max(1, expiresIn)))
    const signed = await client.sign(new Request(url.toString(), { method: 'GET' }), { aws: { signQuery: true } })
    return signed.url
  }

  async size(path: string): Promise<number> {
    return (await this.metadataOrFail(path)).size
  }

  async lastModified(path: string): Promise<Date> {
    return (await this.metadataOrFail(path)).lastModified
  }

  private async metadataOrFail(path: string): Promise<FileMetadata> {
    const metadata = await this.metadata(path)
    if (!metadata) {
      throw new Error(`File not found: ${path}`)
    }
    return metadata
  }

  async metadata(path: string): Promise<FileMetadata | null> {
    const object = await this.bucket().head(this.key(path))
    if (!object) return null
    return {
      path: trimSlashes(path),
      size: object.size,
      lastModified: object.uploaded,
      contentType: object.httpMetadata?.contentType,
      visibility: this.diskVisibility,
      metadata: object.customMetadata,
    }
  }

  async files(directory: string): Promise<string[]> {
    const result: string[] = []
    for await (const page of this.pages({ prefix: this.directoryPrefix(directory), delimiter: '/' })) {
      for (const object of page.objects) {
        if (!object.key.endsWith('/')) result.push(this.unkey(object.key))
      }
    }
    return result.sort()
  }

  async directories(directory: string): Promise<string[]> {
    const result = new Set<string>()
    for await (const page of this.pages({ prefix: this.directoryPrefix(directory), delimiter: '/' })) {
      for (const prefix of page.delimitedPrefixes) {
        const relative = trimTrailingSlashes(this.unkey(prefix))
        if (relative) result.add(relative)
      }
    }
    return Array.from(result).sort()
  }

  async allFiles(directory: string): Promise<string[]> {
    const result: string[] = []
    for await (const page of this.pages({ prefix: this.directoryPrefix(directory) })) {
      for (const object of page.objects) {
        if (!object.key.endsWith('/')) result.push(this.unkey(object.key))
      }
    }
    return result.sort()
  }

  /**
   * Follows `cursor` until `truncated` is false. A single `list()` call is
   * capped at 1000 keys, so a one-page read (what `S3Driver.allFiles` does)
   * silently truncates larger directories.
   */
  private async *pages(options: R2ListOptionsLike): AsyncGenerator<R2ObjectsLike> {
    const bucket = this.bucket()
    let cursor: string | undefined
    do {
      const page = await bucket.list(cursor ? { ...options, cursor } : options)
      yield page
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
  }

  async makeDirectory(path: string): Promise<void> {
    // R2 has no directories. A zero-byte object whose key ends in `/` is the
    // convention S3 consoles use for folders: `directories()` sees it as a
    // delimited prefix, while the trailing-slash filter keeps it out of
    // `files()`/`allFiles()`.
    const key = this.key(path)
    if (!key) return
    await this.bucket().put(`${key}/`, '')
  }

  async deleteDirectory(path: string): Promise<void> {
    // Raw keys, not paths: the folder marker written by makeDirectory ends
    // in `/`, which key() would strip.
    const keys: string[] = []
    for await (const page of this.pages({ prefix: this.directoryPrefix(path) })) {
      for (const object of page.objects) keys.push(object.key)
    }
    await this.deleteKeys(keys)
  }

  async setVisibility(path: string, visibility: 'public' | 'private'): Promise<void> {
    this.assertVisibility(visibility, 'setVisibility')
    // Equal to the bucket's visibility: nothing to do, but keep the
    // not-found contract the other drivers honour.
    await this.metadataOrFail(path)
  }

  async getVisibility(path: string): Promise<'public' | 'private'> {
    await this.metadataOrFail(path)
    return this.diskVisibility
  }

  /** The key prefix (for tests and diagnostics). */
  getPrefix(): string {
    return this.prefix
  }
}

/** Percent-encode a key for the S3 URL path, keeping `/` as a separator. */
function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

function trimTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === '/') end--
  return value.slice(0, end)
}

/**
 * Twin of `@guren/server`'s `trimSlashes` (not exported from the package):
 * regex-free so request-derived paths cannot make it backtrack.
 */
function trimSlashes(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && value[start] === '/') start++
  while (end > start && value[end - 1] === '/') end--
  return value.slice(start, end)
}

function isMissingModule(error: unknown, moduleName: string): boolean {
  if (!error || typeof error !== 'object') return false
  if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') return true
  const message = String((error as { message?: string }).message ?? '')
  return message.includes(`Cannot find package '${moduleName}'`) || message.includes(`Cannot find module '${moduleName}'`)
}

async function importOptionalModule<T>(moduleName: string): Promise<T> {
  try {
    return (await import(moduleName)) as T
  } catch (error) {
    if (isMissingModule(error, moduleName)) {
      throw new Error(`Missing optional dependency "${moduleName}". Install aws4fetch to use R2Driver.temporaryUrl().`)
    }
    throw error
  }
}
