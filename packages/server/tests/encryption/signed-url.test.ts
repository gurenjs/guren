import { describe, test, expect } from 'bun:test'
import {
  generateKey,
  parseAppKey,
  deriveAppKeyring,
  MessageSigner,
  signUrl,
  verifySignedUrl,
} from '../../src/encryption'

function makeKeyring() {
  return deriveAppKeyring({ current: parseAppKey(generateKey()), previous: [] }, 'signed-url-test')
}

describe('signUrl / verifySignedUrl', () => {
  describe('relative input (RFC 0015 §2)', () => {
    test('signs an app-relative path and returns a relative URL', () => {
      const keyring = makeKeyring()
      const signed = signUrl('/attachments/01J8ZK/report.pdf?variant=thumb', keyring, {
        expiresIn: 60_000,
      })

      expect(signed.startsWith('/attachments/01J8ZK/report.pdf?')).toBe(true)
      // The placeholder base must leak into neither the signature nor the output.
      expect(signed).not.toContain('relative.invalid')
      expect(signed).toContain('signature=')
      expect(signed).toContain('expires=')
      expect(verifySignedUrl(signed, keyring, { requireExpiration: true })).toBe(true)
    })

    test('a relative-signed URL verifies when presented on any origin (host-portable by design)', () => {
      const keyring = makeKeyring()
      const signed = signUrl('/files/a.png', keyring, { expiresIn: 60_000 })

      expect(verifySignedUrl(`https://app.example${signed}`, keyring)).toBe(true)
      expect(verifySignedUrl(`https://other.example${signed}`, keyring)).toBe(true)
    })

    test('tampering with path or query invalidates the signature', () => {
      const keyring = makeKeyring()
      const signed = signUrl('/files/a.png?variant=thumb', keyring, { expiresIn: 60_000 })

      expect(verifySignedUrl(signed.replace('/a.png', '/b.png'), keyring)).toBe(false)
      expect(verifySignedUrl(signed.replace('variant=thumb', 'variant=og'), keyring)).toBe(false)
    })

    test('absolute URLs keep working unchanged', () => {
      const keyring = makeKeyring()
      const signed = signUrl('https://example.com/invite?b=2&a=1', keyring, { expiresIn: 60_000 })

      expect(signed.startsWith('https://example.com/invite?')).toBe(true)
      expect(verifySignedUrl(signed, keyring)).toBe(true)
    })
  })

  describe('canonicalization', () => {
    test('query order does not affect verification', () => {
      const keyring = makeKeyring()
      const signed = signUrl('/p?a=1&B=2', keyring)
      const signature = new URL(signed, 'https://x.invalid').searchParams.get('signature')

      // The same signature verifies with the parameters reordered.
      expect(verifySignedUrl(`/p?B=2&a=1&signature=${signature}`, keyring)).toBe(true)
    })

    test('parameters sort by code unit, not by locale', () => {
      const keyring = makeKeyring()
      const signer = new MessageSigner(keyring)

      // Code-unit order puts 'B' (0x42) before 'a' (0x61); locale-aware
      // collation would reverse them. Pin the direction by verifying
      // against independently built tokens over each canonical form.
      const codeUnit = signer.sign({ url: '/p?B=2&a=1' }, { purpose: 'signed-url' })
      const localeish = signer.sign({ url: '/p?a=1&B=2' }, { purpose: 'signed-url' })

      expect(verifySignedUrl(`/p?a=1&B=2&signature=${codeUnit}`, keyring)).toBe(true)
      expect(verifySignedUrl(`/p?a=1&B=2&signature=${localeish}`, keyring)).toBe(false)
    })
  })

  describe('expiry', () => {
    test('rejects expired URLs and honours requireExpiration', () => {
      const keyring = makeKeyring()
      const expired = signUrl('/p', keyring, { expiresIn: -1000 })
      const unexpiring = signUrl('/p', keyring)

      expect(verifySignedUrl(expired, keyring)).toBe(false)
      expect(verifySignedUrl(unexpiring, keyring)).toBe(true)
      expect(verifySignedUrl(unexpiring, keyring, { requireExpiration: true })).toBe(false)
    })

    test('non-integer expires values fail closed even when validly signed', () => {
      const keyring = makeKeyring()

      // Sign URLs that already carry a malformed expires param: the
      // signature over them is genuine, so only the shape gate can reject.
      for (const expires of ['NaN', 'Infinity', '-1', '1e10', '9'.repeat(16)]) {
        const signed = signUrl(`/p?expires=${encodeURIComponent(expires)}`, keyring)
        expect(verifySignedUrl(signed, keyring)).toBe(false)
      }
    })

    test('signUrl rejects a non-finite expiresIn', () => {
      const keyring = makeKeyring()

      expect(() => signUrl('/p', keyring, { expiresIn: Number.NaN })).toThrow(TypeError)
      expect(() => signUrl('/p', keyring, { expiresIn: Number.POSITIVE_INFINITY })).toThrow(TypeError)
    })
  })

  describe('malformed input', () => {
    test('verifySignedUrl returns false instead of throwing', () => {
      const keyring = makeKeyring()

      expect(verifySignedUrl('not a url', keyring)).toBe(false)
      expect(verifySignedUrl('relative/without/slash', keyring)).toBe(false)
      expect(verifySignedUrl('/no-signature-param', keyring)).toBe(false)
    })
  })
})
