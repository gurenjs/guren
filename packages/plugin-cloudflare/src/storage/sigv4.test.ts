import { describe, expect, test } from 'bun:test'
import { presignGetUrl } from './sigv4'

// Known-answer tests. The expected signatures were produced by this
// implementation and cross-checked byte-for-byte against `aws4fetch`
// (the reference this replaced) for every case below, so they pin the
// canonicalization rules that are easy to get subtly wrong: RFC 3986
// escaping beyond encodeURIComponent, per-segment path encoding, and
// sorted query canonicalization.
const CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'auto',
  service: 's3',
}
const DATE = new Date('2026-08-15T10:02:42.000Z')

async function sign(url: string, expiresIn = 3600): Promise<URL> {
  return new URL(await presignGetUrl({ url, ...CREDENTIALS, expiresIn, date: DATE }))
}

describe('presignGetUrl', () => {
  test('signs a plain key', async () => {
    const url = await sign('https://acct.r2.cloudflarestorage.com/bucket/a.png')
    expect(url.pathname).toBe('/bucket/a.png')
    expect(url.searchParams.get('X-Amz-Signature')).toBe(
      'f4ae5edbe355a012a61b7a3ccea1ce2fbfa0c6402ace3d77aee93302256b5f44',
    )
  })

  test('preserves per-segment encoding for keys with spaces', async () => {
    const url = await sign('https://acct.r2.cloudflarestorage.com/bucket/uploads/a%20b/c.png')
    expect(url.pathname).toBe('/bucket/uploads/a%20b/c.png')
    expect(url.searchParams.get('X-Amz-Signature')).toBe(
      'c6472f7f41f7508a61082cfd9284938076cf2f7e91b0fc65e08dd62abbbbd2b1',
    )
  })

  test('handles unicode and RFC 3986 reserved characters', async () => {
    const url = await sign('https://acct.r2.cloudflarestorage.com/bucket/photos/2026/%C3%A9t%C3%A9%20(1).jpg')
    expect(url.pathname).toBe('/bucket/photos/2026/%C3%A9t%C3%A9%20(1).jpg')
    expect(url.searchParams.get('X-Amz-Signature')).toBe(
      '5e85f3d95b3c6ac6d2b8bb79b20fcacf747309ce97fc1f66b6cbae0b54f26444',
    )
  })

  test('emits every parameter the S3 presigned-URL scheme requires', async () => {
    const url = await sign('https://acct.r2.cloudflarestorage.com/bucket/a.png', 900)
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.get('X-Amz-Credential')).toBe('AKIDEXAMPLE/20260815/auto/s3/aws4_request')
    expect(url.searchParams.get('X-Amz-Date')).toBe('20260815T100242Z')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
  })

  test('changes the signature when any signed input changes', async () => {
    const base = await sign('https://acct.r2.cloudflarestorage.com/bucket/a.png')
    const other = await sign('https://acct.r2.cloudflarestorage.com/bucket/b.png')
    const shorter = await sign('https://acct.r2.cloudflarestorage.com/bucket/a.png', 60)
    const later = new URL(
      await presignGetUrl({
        url: 'https://acct.r2.cloudflarestorage.com/bucket/a.png',
        ...CREDENTIALS,
        expiresIn: 3600,
        date: new Date('2026-08-16T10:02:42.000Z'),
      }),
    )
    const signatures = [base, other, shorter, later].map((url) => url.searchParams.get('X-Amz-Signature'))
    expect(new Set(signatures).size).toBe(4)
  })

  test('signs query parameters already on the URL', async () => {
    const withQuery = await sign('https://acct.r2.cloudflarestorage.com/bucket/a.png?versionId=42')
    const withoutQuery = await sign('https://acct.r2.cloudflarestorage.com/bucket/a.png')
    expect(withQuery.searchParams.get('versionId')).toBe('42')
    expect(withQuery.searchParams.get('X-Amz-Signature')).not.toBe(withoutQuery.searchParams.get('X-Amz-Signature'))
  })
})
