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

function canonicalizeUrl(value: string): { canonical: string; url: URL } {
  const url = new URL(value)
  url.searchParams.delete(SIGNATURE_PARAM)
  const params = Array.from(url.searchParams.entries()).sort(([left], [right]) => left.localeCompare(right))
  url.search = ''
  for (const [key, paramValue] of params) {
    url.searchParams.append(key, paramValue)
  }

  return { canonical: `${url.pathname}${url.search}`, url }
}

export function signUrl(value: string, keyring: AppKeyring, options: SignedUrlOptions = {}): string {
  const url = new URL(value)
  if (typeof options.expiresIn === 'number') {
    url.searchParams.set(EXPIRES_PARAM, String(Math.floor((Date.now() + options.expiresIn) / 1000)))
  }

  const { canonical } = canonicalizeUrl(url.toString())
  const signer = new MessageSigner(keyring)
  const signature = signer.sign({ url: canonical }, { purpose: PURPOSE })
  url.searchParams.set(SIGNATURE_PARAM, signature)
  return url.toString()
}

export function verifySignedUrl(value: string, keyring: AppKeyring, options: VerifySignedUrlOptions = {}): boolean {
  const url = new URL(value)
  const signature = url.searchParams.get(SIGNATURE_PARAM)
  if (!signature) {
    return false
  }

  const expires = url.searchParams.get(EXPIRES_PARAM)
  if (options.requireExpiration && !expires) {
    return false
  }

  if (expires && Number(expires) < Math.floor(Date.now() / 1000)) {
    return false
  }

  const { canonical } = canonicalizeUrl(value)
  const signer = new MessageSigner(keyring)
  const payload = signer.verify<{ url: string }>(signature, { purpose: PURPOSE })
  return payload?.url === canonical
}
