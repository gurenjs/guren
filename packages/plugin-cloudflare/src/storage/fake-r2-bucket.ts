import type {
  R2BucketLike,
  R2ListOptionsLike,
  R2ObjectBodyLike,
  R2ObjectLike,
  R2ObjectsLike,
  R2PutOptionsLike,
  R2PutValue,
} from './R2Driver'

interface StoredObject {
  bytes: Uint8Array
  uploaded: Date
  httpMetadata?: R2ObjectBodyLike['httpMetadata']
  customMetadata?: Record<string, string>
}

export interface FakeR2BucketOptions {
  /**
   * Page size for `list()` when the caller passes no `limit`. The real
   * default is 1000; tests lower it to exercise cursor pagination.
   */
  pageSize?: number
  /** Clock for `uploaded`, so tests can assert timestamps. */
  now?: () => Date
}

/**
 * In-memory `R2BucketLike` with the semantics the driver relies on: sorted
 * listing, prefix/delimiter grouping, cursor pagination, the 1000-key
 * `delete()` cap, and `R2ObjectBody` readers. It is a test double, not a
 * spec — the opt-in Miniflare test in `r2-miniflare.test.ts` runs the same
 * assertions against workerd's R2 to keep this honest.
 */
export class FakeR2Bucket implements R2BucketLike {
  private readonly objects = new Map<string, StoredObject>()
  private readonly pageSize: number
  private readonly now: () => Date
  /** Every call, for assertions on batching and pagination. */
  readonly calls: Array<{ method: keyof R2BucketLike; args: unknown[] }> = []

  constructor(options: FakeR2BucketOptions = {}) {
    this.pageSize = options.pageSize ?? 1000
    this.now = options.now ?? (() => new Date())
  }

  async head(key: string): Promise<R2ObjectLike | null> {
    this.calls.push({ method: 'head', args: [key] })
    const stored = this.objects.get(key)
    return stored ? this.toObject(key, stored) : null
  }

  async get(key: string): Promise<R2ObjectBodyLike | null> {
    this.calls.push({ method: 'get', args: [key] })
    const stored = this.objects.get(key)
    if (!stored) return null
    const bytes = stored.bytes
    return {
      ...this.toObject(key, stored),
      body: new Blob([new Uint8Array(bytes)]).stream(),
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      },
      async text() {
        return new TextDecoder().decode(bytes)
      },
    }
  }

  async put(key: string, value: R2PutValue, options?: R2PutOptionsLike): Promise<R2ObjectLike | null> {
    this.calls.push({ method: 'put', args: [key, value, options] })
    const stored: StoredObject = {
      bytes: await toBytes(value),
      uploaded: this.now(),
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
    }
    this.objects.set(key, stored)
    return this.toObject(key, stored)
  }

  async delete(keys: string | string[]): Promise<void> {
    this.calls.push({ method: 'delete', args: [keys] })
    const list = Array.isArray(keys) ? keys : [keys]
    if (list.length > 1000) {
      throw new Error('FakeR2Bucket: delete() accepts at most 1000 keys per call')
    }
    for (const key of list) this.objects.delete(key)
  }

  async list(options: R2ListOptionsLike = {}): Promise<R2ObjectsLike> {
    this.calls.push({ method: 'list', args: [options] })
    const prefix = options.prefix ?? ''
    const delimiter = options.delimiter
    const limit = options.limit ?? this.pageSize

    // One sorted entry list mixing objects and delimited prefixes, so the
    // cursor is simply "how many entries were already returned".
    const entries: Array<{ key: string; kind: 'object' | 'prefix' }> = []
    const seenPrefixes = new Set<string>()
    for (const key of Array.from(this.objects.keys()).sort()) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      const delimiterAt = delimiter ? rest.indexOf(delimiter) : -1
      if (delimiter && delimiterAt !== -1) {
        const grouped = prefix + rest.slice(0, delimiterAt + delimiter.length)
        if (!seenPrefixes.has(grouped)) {
          seenPrefixes.add(grouped)
          entries.push({ key: grouped, kind: 'prefix' })
        }
        continue
      }
      entries.push({ key, kind: 'object' })
    }

    const start = options.cursor ? Number.parseInt(options.cursor, 10) : 0
    const page = entries.slice(start, start + limit)
    const truncated = start + limit < entries.length

    return {
      objects: page
        .filter((entry) => entry.kind === 'object')
        .map((entry) => this.toObject(entry.key, this.objects.get(entry.key)!)),
      delimitedPrefixes: page.filter((entry) => entry.kind === 'prefix').map((entry) => entry.key),
      truncated,
      cursor: truncated ? String(start + limit) : undefined,
    }
  }

  /** Test helpers. */
  keys(): string[] {
    return Array.from(this.objects.keys()).sort()
  }

  clear(): void {
    this.objects.clear()
    this.calls.length = 0
  }

  private toObject(key: string, stored: StoredObject): R2ObjectLike {
    const etag = `"${stored.bytes.byteLength.toString(16)}-${key.length.toString(16)}"`
    return {
      key,
      size: stored.bytes.byteLength,
      uploaded: stored.uploaded,
      etag: etag.slice(1, -1),
      httpEtag: etag,
      httpMetadata: stored.httpMetadata,
      customMetadata: stored.customMetadata,
    }
  }
}

async function toBytes(value: R2PutValue): Promise<Uint8Array> {
  if (value === null) return new Uint8Array()
  if (typeof value === 'string') return new TextEncoder().encode(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
  }
  if ('arrayBuffer' in value) return new Uint8Array(await value.arrayBuffer())
  // A stream: drain it the way workerd would.
  return new Uint8Array(await new Response(value as unknown as ReadableStream).arrayBuffer())
}
