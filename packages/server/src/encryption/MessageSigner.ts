import { createHmac, timingSafeEqual } from 'node:crypto'
import type { AppKeyring } from './app-key'

export interface SignedMessageClaims {
  purpose?: string
  iat: number
  exp?: number
  [key: string]: unknown
}

export interface SignMessageOptions {
  purpose?: string
  expiresIn?: number
}

export interface VerifySignedMessageOptions {
  purpose?: string
  allowExpired?: boolean
}

function encodeBase64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8')
}

function createSignature(input: string, key: Buffer): string {
  return encodeBase64Url(createHmac('sha256', key).update(input).digest())
}

function signaturesMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, 'utf8')
  const expectedBuffer = Buffer.from(expected, 'utf8')
  if (actualBuffer.length !== expectedBuffer.length) {
    return false
  }

  return timingSafeEqual(actualBuffer, expectedBuffer)
}

export class MessageSigner {
  constructor(private readonly keyring: AppKeyring) {}

  sign<T extends Record<string, unknown>>(payload: T, options: SignMessageOptions = {}): string {
    const now = Date.now()
    const claims: SignedMessageClaims = {
      ...payload,
      iat: Math.floor(now / 1000),
      ...(options.purpose ? { purpose: options.purpose } : {}),
      ...(typeof options.expiresIn === 'number'
        ? { exp: Math.floor((now + options.expiresIn) / 1000) }
        : {}),
    }

    const encodedPayload = encodeBase64Url(JSON.stringify(claims))
    const signature = createSignature(encodedPayload, this.keyring.current)
    return `${encodedPayload}.${signature}`
  }

  verify<T extends Record<string, unknown> = Record<string, unknown>>(
    token: string,
    options: VerifySignedMessageOptions = {},
  ): (T & SignedMessageClaims) | null {
    const [encodedPayload, signature, extra] = token.split('.')
    if (!encodedPayload || !signature || extra) {
      return null
    }

    const verified = [this.keyring.current, ...this.keyring.previous].some((key) =>
      signaturesMatch(signature, createSignature(encodedPayload, key)),
    )
    if (!verified) {
      return null
    }

    let payload: SignedMessageClaims
    try {
      payload = JSON.parse(decodeBase64Url(encodedPayload)) as SignedMessageClaims
    } catch {
      return null
    }

    if (options.purpose && payload.purpose !== options.purpose) {
      return null
    }

    if (
      typeof payload.exp === 'number' &&
      Math.floor(Date.now() / 1000) > payload.exp &&
      options.allowExpired !== true
    ) {
      return null
    }

    return payload as T & SignedMessageClaims
  }
}
