import { beforeEach, describe, expect, test } from 'bun:test'
import { FakeR2Bucket, type FakeR2BucketOptions } from './fake-r2-bucket'
import { describeR2DriverConformance } from './r2-driver-conformance'
import { R2Driver, type R2DriverOptions } from './R2Driver'

// The contract itself, shared with the opt-in workerd run.
describeR2DriverConformance('R2Driver (FakeR2Bucket)', {
  bucket: async () => new FakeR2Bucket(),
  reset: async (bucket) => {
    const fake = bucket as FakeR2Bucket
    for (const key of fake.keys()) await fake.delete(key)
    fake.calls.length = 0
  },
  streamingBody: true,
})

// What only the fake can observe: which calls the driver makes, and how it
// behaves at page and batch boundaries.
function createDriver(overrides: Partial<R2DriverOptions> = {}, bucketOptions: FakeR2BucketOptions = {}) {
  const bucket = new FakeR2Bucket(bucketOptions)
  const driver = new R2Driver({ binding: () => bucket, publicUrl: 'https://media.example.com', ...overrides })
  return { bucket, driver }
}

describe('R2Driver against the binding', () => {
  let bucket: FakeR2Bucket
  let driver: R2Driver

  beforeEach(() => {
    ;({ bucket, driver } = createDriver())
  })

  describe('binding resolution', () => {
    test('should not call the binding resolver until an operation runs', () => {
      let calls = 0
      new R2Driver({
        binding: () => {
          calls += 1
          return bucket
        },
      })
      expect(calls).toBe(0)
    })

    test('should throw with wrangler guidance when the resolver returns nothing', async () => {
      const lazy = new R2Driver({ binding: () => undefined })
      await expect(lazy.exists('x')).rejects.toThrow(/r2_buckets/)
      await expect(lazy.exists('x')).rejects.toThrow(/getWorkersEnv/)
    })
  })

  test('put maps contentType and metadata onto httpMetadata and customMetadata', async () => {
    await driver.put('a.json', '{}', { contentType: 'application/json', metadata: { owner: '42' } })
    const object = await bucket.head('a.json')
    expect(object?.httpMetadata).toEqual({ contentType: 'application/json' })
    expect(object?.customMetadata).toEqual({ owner: '42' })
  })

  test('delete does not issue a delete for a missing key', async () => {
    await driver.delete('missing.txt')
    expect(bucket.calls.filter((call) => call.method === 'delete')).toHaveLength(0)
  })

  test('deleteMany with no paths does not touch the bucket', async () => {
    expect(await driver.deleteMany([])).toBe(0)
    expect(bucket.calls).toHaveLength(0)
  })

  test('deleteMany batches keys into 1000-key delete() calls', async () => {
    const paths = Array.from({ length: 2500 }, (_, index) => `bulk/${index}.txt`)
    for (const path of paths) await bucket.put(path, '')
    bucket.calls.length = 0

    expect(await driver.deleteMany(paths)).toBe(2500)

    const batches = bucket.calls.filter((call) => call.method === 'delete').map((call) => call.args[0] as string[])
    expect(batches.map((batch) => batch.length).sort((a, b) => b - a)).toEqual([1000, 1000, 500])
    expect(bucket.keys()).toEqual([])
  })

  test('listings follow the cursor across pages', async () => {
    ;({ bucket, driver } = createDriver({}, { pageSize: 2 }))
    for (let index = 0; index < 7; index++) await driver.put(`p/${index}.txt`, '')
    bucket.calls.length = 0

    const files = await driver.allFiles('p')

    expect(files).toHaveLength(7)
    const lists = bucket.calls.filter((call) => call.method === 'list')
    expect(lists).toHaveLength(4)
    expect((lists[1]!.args[0] as { cursor?: string }).cursor).toBeDefined()
  })

  test('deleteDirectory deletes each page as it is listed', async () => {
    ;({ bucket, driver } = createDriver({}, { pageSize: 3 }))
    for (let index = 0; index < 7; index++) await driver.put(`p/${index}.txt`, '')
    bucket.calls.length = 0

    await driver.deleteDirectory('p')

    const methods = bucket.calls.map((call) => call.method)
    expect(methods).toEqual(['list', 'delete', 'list', 'delete', 'list', 'delete'])
    expect(bucket.keys()).toEqual([])
  })

  test('metadata reports the bucket timestamp', async () => {
    const uploaded = new Date('2026-08-15T00:00:00Z')
    ;({ bucket, driver } = createDriver({}, { now: () => uploaded }))
    await driver.put('a.txt', 'hello')
    expect(await driver.lastModified('a.txt')).toEqual(uploaded)
    expect((await driver.metadata('a.txt'))?.lastModified).toEqual(uploaded)
  })

  describe('temporaryUrl with presign', () => {
    const presign = { accountId: 'acct123', bucket: 'my-bucket', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' }

    test('rejects expirations beyond seven days before signing', async () => {
      const presigned = new R2Driver({ binding: () => bucket, presign })
      const eightDays = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000)
      await expect(presigned.temporaryUrl('a.png', eightDays)).rejects.toThrow(/7 days/)
    })

    test('signs a GET against the S3 endpoint with X-Amz-Expires', async () => {
      const presigned = new R2Driver({ binding: () => bucket, prefix: 'uploads', presign })
      const url = new URL(await presigned.temporaryUrl('a b/c.png', new Date(Date.now() + 3600 * 1000)))
      expect(url.origin).toBe('https://acct123.r2.cloudflarestorage.com')
      expect(url.pathname).toBe('/my-bucket/uploads/a%20b/c.png')
      expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
      expect(url.searchParams.get('X-Amz-Expires')).toBe('3600')
      expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request$/)
      expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    })
  })
})

describe('R2Driver delivery surface (RFC 0015)', () => {
  test('declares presignedGet iff presign credentials are configured', () => {
    const presign = { accountId: 'acct', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' }
    const { driver: bindingOnly } = createDriver()
    const withPresign = new R2Driver({ binding: () => new FakeR2Bucket(), presign })

    expect(bindingOnly.capabilities).toBeUndefined()
    expect(withPresign.capabilities).toEqual({ presignedGet: true })
  })

  test('getStream maps the inclusive range onto R2 offset/length', async () => {
    const { bucket, driver } = createDriver({ prefix: 'media' })
    await driver.put('range.bin', Buffer.from('0123456789'))
    bucket.calls.length = 0

    await driver.getStream('range.bin', { range: { start: 2, end: 5 } })
    await driver.getStream('range.bin', { range: { start: 7 } })
    await driver.getStream('range.bin')

    expect(bucket.calls[0]).toEqual({
      method: 'get',
      args: ['media/range.bin', { range: { offset: 2, length: 4 } }],
    })
    expect(bucket.calls[1]).toEqual({
      method: 'get',
      args: ['media/range.bin', { range: { offset: 7 } }],
    })
    expect(bucket.calls[2]).toEqual({ method: 'get', args: ['media/range.bin'] })
  })

  test('temporaryUrl signs the response overrides into the presigned query', async () => {
    const presign = { accountId: 'acct123', bucket: 'my-bucket', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' }
    const driver = new R2Driver({ binding: () => new FakeR2Bucket(), presign })

    const url = new URL(
      await driver.temporaryUrl('doc.pdf', new Date(Date.now() + 3600 * 1000), {
        responseContentDisposition: 'attachment; filename="doc.pdf"',
        responseContentType: 'application/pdf',
      }),
    )

    expect(url.searchParams.get('response-content-disposition')).toBe('attachment; filename="doc.pdf"')
    expect(url.searchParams.get('response-content-type')).toBe('application/pdf')
    // Present before X-Amz-Signature was computed, so they are signed query
    // parameters — stripping or altering them invalidates the URL.
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)

    const plain = new URL(await driver.temporaryUrl('doc.pdf', new Date(Date.now() + 3600 * 1000)))
    expect(plain.searchParams.has('response-content-disposition')).toBe(false)
    expect(plain.searchParams.has('response-content-type')).toBe(false)
  })
})
