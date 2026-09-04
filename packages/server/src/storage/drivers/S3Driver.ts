import type {
  StorageDriver,
  S3DriverOptions,
  PutOptions,
  FileMetadata,
  GetStreamOptions,
  TemporaryUrlOptions,
  StorageDriverCapabilities,
} from '../types'
import { assertVisibilitySupported, cannedAcl, putAclFields } from './s3-acl'

interface S3Client {
  send(command: unknown): Promise<unknown>
}

/** AWS S3 storage driver. */
export class S3Driver implements StorageDriver {
  // S3's temporaryUrl() is a real SigV4 presign the bucket enforces —
  // declared, not probed (RFC 0015 §3).
  readonly capabilities: StorageDriverCapabilities = { presignedGet: true }

  private client: S3Client | null = null
  private readonly bucket: string
  private readonly region: string
  private readonly endpoint?: string
  private readonly accessKeyId?: string
  private readonly secretAccessKey?: string
  private readonly prefix: string
  private readonly baseUrl: string
  private readonly defaultVisibility: 'public' | 'private'
  private readonly acl: boolean

  constructor(private readonly options: S3DriverOptions) {
    this.client = options.client as S3Client | null
    this.bucket = options.bucket
    this.region = options.region ?? 'us-east-1'
    this.endpoint = options.endpoint
    this.accessKeyId = options.accessKeyId
    this.secretAccessKey = options.secretAccessKey
    this.prefix = options.prefix ?? ''
    this.baseUrl = options.url ?? `https://${this.bucket}.s3.${this.region}.amazonaws.com`
    this.defaultVisibility = options.visibility ?? 'private'
    this.acl = options.acl ?? true
  }

  private async getClient(): Promise<S3Client> {
    if (this.client) {
      return this.client
    }

    const { S3Client } = await importAwsModule('@aws-sdk/client-s3') as {
      S3Client: new (config: unknown) => S3Client
    }

    const config: Record<string, unknown> = {
      region: this.region,
    }

    if (this.endpoint) {
      config.endpoint = this.endpoint
      config.forcePathStyle = true
    }

    if (this.accessKeyId && this.secretAccessKey) {
      config.credentials = {
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
      }
    }

    this.client = new S3Client(config)
    return this.client
  }

  private prefixKey(path: string): string {
    return this.prefix ? `${this.prefix}/${path}` : path
  }

  async put(path: string, content: Buffer | string, options?: PutOptions): Promise<string> {
    // Before the SDK import: a request this disk cannot honour should say so,
    // not report a missing optional dependency that would not have helped.
    assertVisibilitySupported(this.acl, this.defaultVisibility, options?.visibility, 'put')

    const client = await this.getClient()
    const { PutObjectCommand } = await importAwsModule('@aws-sdk/client-s3') as {
      PutObjectCommand: new (input: unknown) => unknown
    }

    const body = typeof content === 'string' ? Buffer.from(content) : content
    const visibility = options?.visibility ?? this.defaultVisibility

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.prefixKey(path),
      Body: body,
      ContentType: options?.contentType,
      ...putAclFields(this.acl, visibility),
      Metadata: options?.metadata,
    })

    await client.send(command)
    return path
  }

  async putFile(path: string, localPath: string, options?: PutOptions): Promise<string> {
    const { readFile } = await import('node:fs/promises')
    const content = await readFile(localPath)
    return this.put(path, content, options)
  }

  async get(path: string): Promise<Buffer | null> {
    const client = await this.getClient()
    const { GetObjectCommand } = await importAwsModule('@aws-sdk/client-s3') as {
      GetObjectCommand: new (input: unknown) => unknown
    }

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.prefixKey(path),
      })

      const response = await client.send(command) as { Body?: { transformToByteArray(): Promise<Uint8Array> } }

      if (!response.Body) {
        return null
      }

      const bytes = await response.Body.transformToByteArray()
      return Buffer.from(bytes)
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'name' in error && error.name === 'NoSuchKey') {
        return null
      }
      throw error
    }
  }

  async getAsString(path: string): Promise<string | null> {
    const content = await this.get(path)
    return content ? content.toString('utf-8') : null
  }

  async getStream(path: string, options?: GetStreamOptions): Promise<ReadableStream<Uint8Array> | null> {
    const client = await this.getClient()
    const { GetObjectCommand } = await importAwsModule('@aws-sdk/client-s3') as {
      GetObjectCommand: new (input: unknown) => unknown
    }

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.prefixKey(path),
        ...(options?.range
          ? { Range: `bytes=${options.range.start}-${options.range.end ?? ''}` }
          : {}),
      })

      const response = await client.send(command) as {
        Body?: { transformToWebStream(): ReadableStream<Uint8Array> }
      }

      // The SDK body is not itself a web stream on Node; the contract is a
      // global web ReadableStream, so normalize at the driver boundary.
      return response.Body ? response.Body.transformToWebStream() : null
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'name' in error && error.name === 'NoSuchKey') {
        return null
      }
      throw error
    }
  }

  async exists(path: string): Promise<boolean> {
    const client = await this.getClient()
    const { HeadObjectCommand } = await importAwsModule('@aws-sdk/client-s3') as {
      HeadObjectCommand: new (input: unknown) => unknown
    }

    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.prefixKey(path),
      })

      await client.send(command)
      return true
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'name' in error && error.name === 'NotFound') {
        return false
      }
      throw error
    }
  }

  async delete(path: string): Promise<boolean> {
    const client = await this.getClient()
    const { DeleteObjectCommand } = await importAwsModule('@aws-sdk/client-s3') as {
      DeleteObjectCommand: new (input: unknown) => unknown
    }

    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.prefixKey(path),
      })

      await client.send(command)
      return true
    } catch {
      return false
    }
  }

  async deleteMany(paths: string[]): Promise<number> {
    if (paths.length === 0) {
      return 0
    }

    const client = await this.getClient()
    const { DeleteObjectsCommand } = await importAwsModule('@aws-sdk/client-s3') as {
      DeleteObjectsCommand: new (input: unknown) => unknown
    }

    // DeleteObjects accepts at most 1000 keys per request; a larger payload
    // is rejected outright, deleting nothing.
    let deleted = 0
    for (let index = 0; index < paths.length; index += 1000) {
      const command = new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: {
          Objects: paths.slice(index, index + 1000).map((path) => ({ Key: this.prefixKey(path) })),
        },
      })

      const response = await client.send(command) as { Deleted?: unknown[] }
      deleted += response.Deleted?.length ?? 0
    }
    return deleted
  }

  async copy(from: string, to: string): Promise<string> {
    const client = await this.getClient()
    const { CopyObjectCommand } = await importAwsModule('@aws-sdk/client-s3') as {
      CopyObjectCommand: new (input: unknown) => unknown
    }

    const command = new CopyObjectCommand({
      Bucket: this.bucket,
      CopySource: `${this.bucket}/${this.prefixKey(from)}`,
      Key: this.prefixKey(to),
    })

    await client.send(command)
    return to
  }

  async move(from: string, to: string): Promise<string> {
    await this.copy(from, to)
    await this.delete(from)
    return to
  }

  url(path: string): string {
    return `${this.baseUrl}/${this.prefixKey(path)}`
  }

  async temporaryUrl(path: string, expiration: Date, options?: TemporaryUrlOptions): Promise<string> {
    const client = await this.getClient()
    const { GetObjectCommand } = await importAwsModule('@aws-sdk/client-s3') as {
      GetObjectCommand: new (input: unknown) => unknown
    }
    const { getSignedUrl } = await importAwsModule('@aws-sdk/s3-request-presigner') as {
      getSignedUrl: (client: unknown, command: unknown, options: { expiresIn: number }) => Promise<string>
    }

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.prefixKey(path),
      ...(options?.responseContentDisposition
        ? { ResponseContentDisposition: options.responseContentDisposition }
        : {}),
      ...(options?.responseContentType
        ? { ResponseContentType: options.responseContentType }
        : {}),
    })

    const expiresIn = Math.max(1, Math.floor((expiration.getTime() - Date.now()) / 1000))
    return getSignedUrl(client, command, { expiresIn })
  }

  async size(path: string): Promise<number> {
    const metadata = await this.metadata(path)

    if (!metadata) {
      throw new Error(`File not found: ${path}`)
    }

    return metadata.size
  }

  async lastModified(path: string): Promise<Date> {
    const metadata = await this.metadata(path)

    if (!metadata) {
      throw new Error(`File not found: ${path}`)
    }

    return metadata.lastModified
  }

  async metadata(path: string): Promise<FileMetadata | null> {
    const client = await this.getClient()
    const { HeadObjectCommand } = await importAwsModule('@aws-sdk/client-s3') as {
      HeadObjectCommand: new (input: unknown) => unknown
    }

    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.prefixKey(path),
      })

      const response = await client.send(command) as {
        ContentLength?: number
        LastModified?: Date
        ContentType?: string
        Metadata?: Record<string, string>
      }

      return {
        path,
        size: response.ContentLength ?? 0,
        lastModified: response.LastModified ?? new Date(),
        contentType: response.ContentType,
        metadata: response.Metadata,
      }
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'name' in error && error.name === 'NotFound') {
        return null
      }
      throw error
    }
  }

  /** `metadata()`, but honouring the contract's not-found error. */
  private async metadataOrFail(path: string): Promise<FileMetadata> {
    const metadata = await this.metadata(path)
    if (!metadata) {
      throw new Error(`File not found: ${path}`)
    }
    return metadata
  }

  /**
   * Follows `NextContinuationToken` to exhaustion: one request returns at most
   * 1000 entries, so a single-page read silently truncates larger listings.
   */
  private async listAll(input: Record<string, unknown>): Promise<{
    contents: Array<{ Key?: string }>
    commonPrefixes: Array<{ Prefix?: string }>
  }> {
    const client = await this.getClient()
    const { ListObjectsV2Command } = await importAwsModule('@aws-sdk/client-s3') as {
      ListObjectsV2Command: new (input: unknown) => unknown
    }

    const contents: Array<{ Key?: string }> = []
    const commonPrefixes: Array<{ Prefix?: string }> = []
    let continuationToken: string | undefined

    do {
      const command = new ListObjectsV2Command(
        continuationToken ? { ...input, ContinuationToken: continuationToken } : input
      )
      const response = await client.send(command) as {
        Contents?: Array<{ Key?: string }>
        CommonPrefixes?: Array<{ Prefix?: string }>
        IsTruncated?: boolean
        NextContinuationToken?: string
      }
      contents.push(...(response.Contents ?? []))
      commonPrefixes.push(...(response.CommonPrefixes ?? []))
      if (response.IsTruncated) {
        // A token that is missing or repeats cannot advance: returning here would
        // truncate, re-sending would loop. S3-compatible endpoints emit such pages.
        const next = response.NextContinuationToken
        if (!next || next === continuationToken) {
          throw new Error(
            'S3 listing reported IsTruncated without an advancing NextContinuationToken; refusing to return an incomplete listing.'
          )
        }
        continuationToken = next
      } else {
        continuationToken = undefined
      }
    } while (continuationToken)

    return { contents, commonPrefixes }
  }

  /**
   * The prefixed key with exactly one trailing slash, empty at the root —
   * appending `/` to `prefixKey('')` on a prefixed disk yields `prefix//`,
   * which matches nothing.
   */
  private listingPrefix(directory: string): string {
    const prefix = this.prefixKey(directory)
    let end = prefix.length
    while (end > 0 && prefix.charCodeAt(end - 1) === 0x2f /* '/' */) {
      end--
    }
    const trimmed = prefix.slice(0, end)
    return trimmed ? `${trimmed}/` : ''
  }

  async files(directory: string): Promise<string[]> {
    const { contents } = await this.listAll({
      Bucket: this.bucket,
      Prefix: this.listingPrefix(directory),
      Delimiter: '/',
    })

    return contents
      .map((item) => item.Key?.replace(this.prefix ? `${this.prefix}/` : '', '') ?? '')
      .filter((key) => key && !key.endsWith('/'))
  }

  async directories(directory: string): Promise<string[]> {
    const { commonPrefixes } = await this.listAll({
      Bucket: this.bucket,
      Prefix: this.listingPrefix(directory),
      Delimiter: '/',
    })

    return commonPrefixes
      .map((item) =>
        item.Prefix?.replace(this.prefix ? `${this.prefix}/` : '', '').replace(/\/$/, '') ?? ''
      )
      .filter(Boolean)
  }

  async allFiles(directory: string): Promise<string[]> {
    const { contents } = await this.listAll({
      Bucket: this.bucket,
      Prefix: this.listingPrefix(directory),
    })

    return contents
      .map((item) => item.Key?.replace(this.prefix ? `${this.prefix}/` : '', '') ?? '')
      .filter((key) => key && !key.endsWith('/'))
  }

  async makeDirectory(path: string): Promise<void> {
    // S3 doesn't have directories, but we can create a marker object
    await this.put(`${path}/.keep`, '')
  }

  async deleteDirectory(path: string): Promise<void> {
    const files = await this.allFiles(path)
    if (files.length > 0) {
      await this.deleteMany(files)
    }
  }

  async setVisibility(path: string, visibility: 'public' | 'private'): Promise<void> {
    assertVisibilitySupported(this.acl, this.defaultVisibility, visibility, 'setVisibility')
    if (!this.acl) {
      // No ACL to write, but the contract still forbids reporting success for an
      // object that is not there.
      await this.metadataOrFail(path)
      return
    }
    const client = await this.getClient()
    const { PutObjectAclCommand } = await importAwsModule('@aws-sdk/client-s3') as {
      PutObjectAclCommand: new (input: unknown) => unknown
    }

    const command = new PutObjectAclCommand({
      Bucket: this.bucket,
      Key: this.prefixKey(path),
      ACL: cannedAcl(visibility),
    })

    await client.send(command)
  }

  async getVisibility(path: string): Promise<'public' | 'private'> {
    if (!this.acl) {
      await this.metadataOrFail(path)
      return this.defaultVisibility
    }
    const client = await this.getClient()
    const { GetObjectAclCommand } = await importAwsModule('@aws-sdk/client-s3') as {
      GetObjectAclCommand: new (input: unknown) => unknown
    }

    const command = new GetObjectAclCommand({
      Bucket: this.bucket,
      Key: this.prefixKey(path),
    })

    const response = await client.send(command) as {
      Grants?: Array<{ Grantee?: { URI?: string }; Permission?: string }>
    }

    const isPublic = response.Grants?.some(
      (grant) =>
        grant.Grantee?.URI === 'http://acs.amazonaws.com/groups/global/AllUsers' &&
        grant.Permission === 'READ'
    )

    return isPublic ? 'public' : 'private'
  }

  getBucket(): string {
    return this.bucket
  }

  getPrefix(): string {
    return this.prefix
  }
}

function isMissingAwsModule(error: unknown, moduleName: string): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: string }).code
  if (code === 'ERR_MODULE_NOT_FOUND') return true
  const message = String((error as { message?: string }).message ?? '')
  return (
    message.includes(`Cannot find package '${moduleName}'`) ||
    message.includes(`Cannot find module '${moduleName}'`)
  )
}

async function importAwsModule<T>(moduleName: string): Promise<T> {
  try {
    return await import(moduleName) as T
  } catch (error) {
    if (isMissingAwsModule(error, moduleName)) {
      throw new Error(
        `Missing optional dependency "${moduleName}". Install @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner to use the S3 driver.`
      )
    }
    throw error
  }
}
