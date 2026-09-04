import type { AppKeyring } from './app-key'
import { MessageSigner } from './MessageSigner'

export interface SignedUrlOptions {
  expiresIn?: number
}

export interface VerifySignedUrlOptions {
  requireExpiration?: boolean
}

const PURPOSE = 'signed-url'
const SIGNATURE_PARAM = 'signature'
const EXPIRES_PARAM = 'expires'

// App-relative input ('/path?query') is parsed against this base; the origin
// must never reach the signature (the canonical form is path + query) or the
// return value (relative in, relative out) — RFC 0015 §2.
const RELATIVE_BASE = 'https://relative.invalid'
const RELATIVE_ORIGIN = new URL(RELATIVE_BASE).origin

// `expires` must be a plain positive decimal integer in unix seconds. The
// bound matters: `Number(expires) < now` alone lets `NaN` and `Infinity`
// verify forever. 15 digits stays inside Number.MAX_SAFE_INTEGER.
const EXPIRES_SHAPE = /^[0-9]{1,15}$/

function parseUrl(value: string): { url: URL; relative: boolean } {
  const relative = value.startsWith('/')
  const url = relative ? new URL(value, RELATIVE_BASE) : new URL(value)

  // `pathname + search` — the canonical form and the returned string — must
  // re-parse to the same thing. `//host/path` starts with `/` yet parses as an
  // *authority* the canonical form drops, so `'//evil' + signed` would verify;
  // and a pathname normalizing to `//…` serializes off this origin, so
  // `signUrl` would emit a URL its own verifier rejects.
  if (relative && (url.origin !== RELATIVE_ORIGIN || url.pathname.startsWith('//'))) {
    throw new TypeError(`signed-url: an app-relative URL must not begin with an authority, got ${value}`)
  }

  return { url, relative }
}

function serializeUrl(url: URL, relative: boolean): string {
  return relative ? `${url.pathname}${url.search}` : url.toString()
}

function canonicalizeUrl(url: URL): string {
  const canonical = new URL(url.toString())
  canonical.searchParams.delete(SIGNATURE_PARAM)
  // Code-unit comparison, not localeCompare: a locale-dependent order would
  // let signer and verifier disagree on the same URL.
  const params = Array.from(canonical.searchParams.entries()).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )
  canonical.search = ''
  for (const [key, paramValue] of params) {
    canonical.searchParams.append(key, paramValue)
  }

  return `${canonical.pathname}${canonical.search}`
}

export function signUrl(value: string, keyring: AppKeyring, options: SignedUrlOptions = {}): string {
  const { url, relative } = parseUrl(value)
  if (typeof options.expiresIn === 'number') {
    if (!Number.isFinite(options.expiresIn)) {
      throw new TypeError(
        `signUrl: expiresIn must be a finite number of milliseconds, got ${options.expiresIn}`,
      )
    }
    url.searchParams.set(EXPIRES_PARAM, String(Math.floor((Date.now() + options.expiresIn) / 1000)))
  }

  const canonical = canonicalizeUrl(url)
  const signer = new MessageSigner(keyring)
  const signature = signer.sign({ url: canonical }, { purpose: PURPOSE })
  url.searchParams.set(SIGNATURE_PARAM, signature)
  return serializeUrl(url, relative)
}

export function verifySignedUrl(value: string, keyring: AppKeyring, options: VerifySignedUrlOptions = {}): boolean {
  // A verifier is handed attacker-controlled input; malformed input is a
  // failed verification, not an exception for the caller to remember.
  let url: URL
  try {
    url = parseUrl(value).url
  } catch {
    return false
  }

  const signature = url.searchParams.get(SIGNATURE_PARAM)
  if (!signature) {
    return false
  }

  const expires = url.searchParams.get(EXPIRES_PARAM)
  if (options.requireExpiration && !expires) {
    return false
  }

  if (expires !== null) {
    if (!EXPIRES_SHAPE.test(expires)) {
      return false
    }
    if (Number(expires) < Math.floor(Date.now() / 1000)) {
      return false
    }
  }

  const canonical = canonicalizeUrl(url)
  const signer = new MessageSigner(keyring)
  const payload = signer.verify<{ url: string }>(signature, { purpose: PURPOSE })
  return payload?.url === canonical
}
