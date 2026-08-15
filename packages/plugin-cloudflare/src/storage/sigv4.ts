/**
 * The slice of AWS Signature Version 4 needed to presign a GET against an
 * S3-compatible endpoint, on WebCrypto alone.
 *
 * Written here rather than taken from a package because the only thing to
 * import is a signature: R2 presigning is one request shape (GET, no body,
 * `host` the sole signed header), the algorithm is frozen by AWS, and a
 * dependency the bundler has to resolve is exactly what broke the first
 * attempt at this — a variable-specifier dynamic import that no Workers
 * bundler could follow, so `temporaryUrl()` threw `No such module` on the
 * one runtime this driver runs on.
 *
 * `crypto.subtle` is a global on workerd, Bun, and Node 18+, so this needs
 * no runtime shims.
 */

export interface PresignGetOptions {
  /** Absolute URL of the object, unsigned. Existing query params are signed too. */
  url: string
  accessKeyId: string
  secretAccessKey: string
  /** R2 uses `auto`. */
  region: string
  /** `s3` for R2's S3-compatible endpoint. */
  service: string
  /** Lifetime in seconds, from `date`. */
  expiresIn: number
  /** Injectable clock; tests pin it to keep signatures reproducible. */
  date?: Date
}

const ALGORITHM = 'AWS4-HMAC-SHA256'
const TERMINATOR = 'aws4_request'
/**
 * S3 accepts an unsigned payload for presigned URLs — the signature covers
 * the request line, the query, and `host`, not the bytes.
 */
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'

/**
 * Percent-encoding per RFC 3986, which is stricter than `encodeURIComponent`:
 * `!`, `'`, `(`, `)` and `*` are reserved and must be escaped, or the
 * canonical request the server rebuilds will not match ours.
 */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/** Path segments are encoded individually; `/` stays a separator. */
function canonicalPath(pathname: string): string {
  return pathname.split('/').map(decodeAndEncodeSegment).join('/')
}

/**
 * The URL arrives already percent-encoded (callers build it with `URL`), but
 * SigV4 canonicalizes from the decoded form — encoding again without
 * decoding first would sign `%2520` where the server sees `%20`.
 */
function decodeAndEncodeSegment(segment: string): string {
  return encodeRfc3986(decodeURIComponent(segment))
}

/** Query parameters sorted by encoded name, then encoded value. */
function canonicalQuery(searchParams: URLSearchParams): string {
  return Array.from(searchParams)
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName === rightName ? (leftValue < rightValue ? -1 : 1) : leftName < rightName ? -1 : 1,
    )
    .map(([name, value]) => `${name}=${value}`)
    .join('&')
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

async function hmac(key: ArrayBuffer | Uint8Array, value: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(value))
}

/** `AWS4<secret>` → date → region → service → terminator. */
async function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const initial = new TextEncoder().encode(`AWS4${secretAccessKey}`)
  const byDate = await hmac(initial, dateStamp)
  const byRegion = await hmac(byDate, region)
  const byService = await hmac(byRegion, service)
  return hmac(byService, TERMINATOR)
}

/**
 * Presign a GET so the URL alone authorizes the read until it expires.
 *
 * @returns the signed absolute URL
 */
export async function presignGetUrl(options: PresignGetOptions): Promise<string> {
  const { accessKeyId, secretAccessKey, region, service, expiresIn } = options
  const date = options.date ?? new Date()

  // `20260815T100242Z` and its `20260815` prefix.
  const amzDate = `${date.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`
  const dateStamp = amzDate.slice(0, 8)
  const scope = `${dateStamp}/${region}/${service}/${TERMINATOR}`

  const url = new URL(options.url)
  url.searchParams.set('X-Amz-Algorithm', ALGORITHM)
  url.searchParams.set('X-Amz-Credential', `${accessKeyId}/${scope}`)
  url.searchParams.set('X-Amz-Date', amzDate)
  url.searchParams.set('X-Amz-Expires', String(expiresIn))
  url.searchParams.set('X-Amz-SignedHeaders', 'host')

  const canonicalRequest = [
    'GET',
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    `host:${url.host}\n`,
    'host',
    UNSIGNED_PAYLOAD,
  ].join('\n')

  const stringToSign = [ALGORITHM, amzDate, scope, await sha256Hex(canonicalRequest)].join('\n')
  const key = await signingKey(secretAccessKey, dateStamp, region, service)
  url.searchParams.set('X-Amz-Signature', toHex(await hmac(key, stringToSign)))

  return url.toString()
}
