import { beforeEach, describe, expect, test } from 'bun:test'
import { FakeR2Bucket } from './fake-r2-bucket'
import { R2Driver } from './R2Driver'

function createDriver(
  overrides: Partial<ConstructorParameters<typeof R2Driver>[0]> = {},
  bucketOptions: ConstructorParameters<typeof FakeR2Bucket>[0] = {},
) {
  const bucket = new FakeR2Bucket(bucketOptions)
  const driver = new R2Driver({ binding: () => bucket, publicUrl: 'https://media.example.com', ...overrides })
  return { bucket, driver }
}

describe('R2Driver', () => {
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

  describe('put/get', () => {
    test('stores and retrieves a string', async () => {
      await driver.put('test.txt', 'Hello, World!')
      expect((await driver.get('test.txt'))?.toString()).toBe('Hello, World!')
    })

    test('stores a Buffer and reads it back as a Buffer', async () => {
      await driver.put('binary.bin', Buffer.from([1, 2, 3, 255]))
      const content = await driver.get('binary.bin')
      expect(content).toBeInstanceOf(Buffer)
      expect(Array.from(content!)).toEqual([1, 2, 3, 255])
    })

    test('returns null for a missing file', async () => {
      expect(await driver.get('missing.txt')).toBeNull()
      expect(await driver.getAsString('missing.txt')).toBeNull()
    })

    test('normalizes leading and trailing slashes and returns the stored path', async () => {
      expect(await driver.put('/path/to/file.txt/', 'content')).toBe('path/to/file.txt')
      expect(await driver.getAsString('path/to/file.txt')).toBe('content')
      expect(bucket.keys()).toEqual(['path/to/file.txt'])
    })

    test('maps contentType and metadata onto httpMetadata and customMetadata', async () => {
      await driver.put('a.json', '{}', { contentType: 'application/json', metadata: { owner: '42' } })
      const object = await bucket.head('a.json')
      expect(object?.httpMetadata).toEqual({ contentType: 'application/json' })
      expect(object?.customMetadata).toEqual({ owner: '42' })
    })

    test('applies the prefix to every key', async () => {
      const prefixed = new R2Driver({ binding: () => bucket, prefix: '/uploads/' })
      await prefixed.put('a.txt', 'x')
      expect(bucket.keys()).toEqual(['uploads/a.txt'])
      expect(await prefixed.getAsString('a.txt')).toBe('x')
      expect(prefixed.getPrefix()).toBe('uploads')
    })
  })

  describe('putFile', () => {
    test('throws: Workers has no filesystem', async () => {
      await expect(driver.putFile('a.txt', '/tmp/a.txt')).rejects.toThrow(/no filesystem/)
    })
  })

  describe('exists', () => {
    test('reflects presence via head()', async () => {
      await driver.put('test.txt', 'content')
      expect(await driver.exists('test.txt')).toBe(true)
      expect(await driver.exists('missing.txt')).toBe(false)
    })
  })

  describe('delete', () => {
    test('returns true when the object existed and false when it did not', async () => {
      await driver.put('test.txt', 'content')
      expect(await driver.delete('test.txt')).toBe(true)
      expect(await driver.exists('test.txt')).toBe(false)
      expect(await driver.delete('test.txt')).toBe(false)
    })

    test('does not issue a delete for a missing key', async () => {
      await driver.delete('missing.txt')
      expect(bucket.calls.filter((call) => call.method === 'delete')).toHaveLength(0)
    })
  })

  describe('deleteMany', () => {
    test('returns 0 for no paths without touching the bucket', async () => {
      expect(await driver.deleteMany([])).toBe(0)
      expect(bucket.calls).toHaveLength(0)
    })

    test('batches keys into 1000-key delete() calls', async () => {
      const paths = Array.from({ length: 2500 }, (_, index) => `bulk/${index}.txt`)
      for (const path of paths) await bucket.put(path, '')
      bucket.calls.length = 0

      expect(await driver.deleteMany(paths)).toBe(2500)

      const batches = bucket.calls.filter((call) => call.method === 'delete').map((call) => call.args[0] as string[])
      expect(batches.map((batch) => batch.length)).toEqual([1000, 1000, 500])
      expect(bucket.keys()).toEqual([])
    })

    test('deduplicates paths', async () => {
      await driver.put('a.txt', 'x')
      expect(await driver.deleteMany(['a.txt', '/a.txt', 'a.txt/'])).toBe(1)
    })
  })

  describe('copy/move', () => {
    test('copies bytes and metadata to the new key', async () => {
      await driver.put('src.txt', 'content', { contentType: 'text/plain', metadata: { k: 'v' } })
      expect(await driver.copy('src.txt', 'dst.txt')).toBe('dst.txt')
      expect(await driver.getAsString('dst.txt')).toBe('content')
      expect(await driver.getAsString('src.txt')).toBe('content')
      const copied = await bucket.head('dst.txt')
      expect(copied?.httpMetadata).toEqual({ contentType: 'text/plain' })
      expect(copied?.customMetadata).toEqual({ k: 'v' })
    })

    test('throws when the source is missing', async () => {
      await expect(driver.copy('missing.txt', 'dst.txt')).rejects.toThrow('File not found: missing.txt')
    })

    test('moves by copying then deleting the source', async () => {
      await driver.put('src.txt', 'content')
      expect(await driver.move('src.txt', 'dst.txt')).toBe('dst.txt')
      expect(await driver.exists('src.txt')).toBe(false)
      expect(await driver.getAsString('dst.txt')).toBe('content')
    })
  })

  describe('url', () => {
    test('joins publicUrl, prefix and key', () => {
      const prefixed = new R2Driver({ binding: () => bucket, publicUrl: 'https://media.example.com/', prefix: 'uploads' })
      expect(prefixed.url('/a/b.png')).toBe('https://media.example.com/uploads/a/b.png')
    })

    test('throws without publicUrl', () => {
      const bare = new R2Driver({ binding: () => bucket })
      expect(() => bare.url('a.png')).toThrow(/publicUrl/)
    })
  })

  describe('temporaryUrl', () => {
    test('throws with guidance when presign is not configured', async () => {
      await expect(driver.temporaryUrl('a.png', new Date(Date.now() + 60_000))).rejects.toThrow(/presign/)
      await expect(driver.temporaryUrl('a.png', new Date(Date.now() + 60_000))).rejects.toThrow(/signed app route/)
    })

    test('rejects expirations beyond seven days before signing', async () => {
      const presigned = new R2Driver({
        binding: () => bucket,
        presign: { accountId: 'acct', bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'SK' },
      })
      const eightDays = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000)
      await expect(presigned.temporaryUrl('a.png', eightDays)).rejects.toThrow(/7 days/)
    })

    test('signs a GET against the S3 endpoint with X-Amz-Expires when presign is configured', async () => {
      const presigned = new R2Driver({
        binding: () => bucket,
        prefix: 'uploads',
        presign: { accountId: 'acct123', bucket: 'my-bucket', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
      })
      const url = new URL(await presigned.temporaryUrl('a b/c.png', new Date(Date.now() + 3600 * 1000)))
      expect(url.origin).toBe('https://acct123.r2.cloudflarestorage.com')
      expect(url.pathname).toBe('/my-bucket/uploads/a%20b/c.png')
      expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
      expect(url.searchParams.get('X-Amz-Expires')).toBe('3600')
      expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request$/)
      expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  describe('size/lastModified/metadata', () => {
    test('reads from head()', async () => {
      const uploaded = new Date('2026-08-15T00:00:00Z')
      ;({ bucket, driver } = createDriver({}, { now: () => uploaded }))
      await driver.put('a.txt', 'hello', { contentType: 'text/plain', metadata: { k: 'v' } })

      expect(await driver.size('a.txt')).toBe(5)
      expect(await driver.lastModified('a.txt')).toEqual(uploaded)
      expect(await driver.metadata('a.txt')).toEqual({
        path: 'a.txt',
        size: 5,
        lastModified: uploaded,
        contentType: 'text/plain',
        visibility: 'public',
        metadata: { k: 'v' },
      })
    })

    test('throws for size/lastModified of a missing file and returns null metadata', async () => {
      await expect(driver.size('missing')).rejects.toThrow('File not found: missing')
      await expect(driver.lastModified('missing')).rejects.toThrow('File not found: missing')
      expect(await driver.metadata('missing')).toBeNull()
    })
  })

  describe('files/directories/allFiles', () => {
    beforeEach(async () => {
      await driver.put('dir/file1.txt', '1')
      await driver.put('dir/file2.txt', '2')
      await driver.put('dir/sub/file3.txt', '3')
      await driver.put('dir/sub/deep/file4.txt', '4')
      await driver.put('other/file5.txt', '5')
    })

    test('files lists direct children only, as app-relative paths', async () => {
      expect(await driver.files('dir')).toEqual(['dir/file1.txt', 'dir/file2.txt'])
      expect(await driver.files('/dir/')).toEqual(['dir/file1.txt', 'dir/file2.txt'])
    })

    test('directories lists direct subdirectories', async () => {
      expect(await driver.directories('dir')).toEqual(['dir/sub'])
      expect(await driver.directories('')).toEqual(['dir', 'other'])
    })

    test('allFiles lists recursively', async () => {
      expect(await driver.allFiles('dir')).toEqual([
        'dir/file1.txt',
        'dir/file2.txt',
        'dir/sub/deep/file4.txt',
        'dir/sub/file3.txt',
      ])
    })

    test('strips the prefix from listed paths', async () => {
      const prefixed = new R2Driver({ binding: () => bucket, prefix: 'dir' })
      expect(await prefixed.files('')).toEqual(['file1.txt', 'file2.txt'])
      expect(await prefixed.directories('')).toEqual(['sub'])
      expect(await prefixed.allFiles('sub')).toEqual(['sub/deep/file4.txt', 'sub/file3.txt'])
    })

    test('follows the cursor across pages', async () => {
      ;({ bucket, driver } = createDriver({}, { pageSize: 2 }))
      for (let index = 0; index < 7; index++) await driver.put(`p/${index}.txt`, '')
      bucket.calls.length = 0

      const files = await driver.allFiles('p')

      expect(files).toHaveLength(7)
      const lists = bucket.calls.filter((call) => call.method === 'list')
      expect(lists).toHaveLength(4)
      expect((lists[1]!.args[0] as { cursor?: string }).cursor).toBeDefined()
    })

    test('does not list a directory marker as a file', async () => {
      await driver.makeDirectory('dir/empty')
      expect(await driver.directories('dir')).toEqual(['dir/empty', 'dir/sub'])
      expect(await driver.files('dir/empty')).toEqual([])
    })
  })

  describe('deleteDirectory', () => {
    test('deletes everything under the directory', async () => {
      await driver.put('dir/file1.txt', '1')
      await driver.put('dir/sub/file2.txt', '2')
      await driver.put('dir2/file3.txt', '3')

      await driver.deleteDirectory('dir')

      expect(bucket.keys()).toEqual(['dir2/file3.txt'])
    })

    test('removes folder markers and respects the prefix', async () => {
      const prefixed = new R2Driver({ binding: () => bucket, prefix: 'app' })
      await prefixed.makeDirectory('dir/empty')
      await prefixed.put('dir/a.txt', '1')
      await bucket.put('other/keep.txt', '')

      await prefixed.deleteDirectory('dir')

      expect(bucket.keys()).toEqual(['other/keep.txt'])
    })
  })

  describe('visibility', () => {
    test('defaults to public when publicUrl is set and private otherwise', async () => {
      await driver.put('a.txt', 'x')
      expect(await driver.getVisibility('a.txt')).toBe('public')

      const privateDriver = new R2Driver({ binding: () => bucket })
      expect(await privateDriver.getVisibility('a.txt')).toBe('private')
    })

    test('accepts a matching visibility as a no-op', async () => {
      await driver.put('a.txt', 'x', { visibility: 'public' })
      await driver.setVisibility('a.txt', 'public')
      expect(await driver.getVisibility('a.txt')).toBe('public')
    })

    test('throws on a conflicting visibility instead of pretending', async () => {
      await expect(driver.put('a.txt', 'x', { visibility: 'private' })).rejects.toThrow(/no per-object visibility/)
      expect(bucket.keys()).toEqual([])

      await driver.put('a.txt', 'x')
      await expect(driver.setVisibility('a.txt', 'private')).rejects.toThrow(/no per-object visibility/)
    })

    test('getVisibility/setVisibility throw for a missing file', async () => {
      await expect(driver.getVisibility('missing')).rejects.toThrow('File not found: missing')
      await expect(driver.setVisibility('missing', 'public')).rejects.toThrow('File not found: missing')
    })
  })
})
