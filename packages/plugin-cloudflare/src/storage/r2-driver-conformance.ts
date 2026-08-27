import { beforeEach, describe, expect, test } from 'bun:test'
import { R2Driver, type R2BucketLike, type R2DriverOptions } from './R2Driver'

export interface R2ConformanceHarness {
  /** A bucket for the suite; called once. */
  bucket(): Promise<R2BucketLike>
  /** Empties the bucket between tests. */
  reset(bucket: R2BucketLike): Promise<void>
  /**
   * Whether methods that hand `get().body` onward can run in this harness:
   * `copy()`/`move()` pipe it into `put()`, `getStream()` returns it to the
   * caller. Miniflare's binding proxy cannot marshal that stream, so its
   * harness runs all three inside workerd instead.
   */
  streamingBody: boolean
}

/**
 * The driver-level contract, written once and run against both
 * `FakeR2Bucket` and workerd's real R2 (opt-in) — so every semantic the fake
 * encodes is also asserted against the runtime, not only the ones somebody
 * remembered to duplicate. Harness-specific assertions (call counts,
 * pagination page size, presign URL shape) live in the callers.
 */
export function describeR2DriverConformance(name: string, harness: R2ConformanceHarness): void {
  describe(name, () => {
    let bucket: R2BucketLike
    let driver: R2Driver
    const make = (options: Partial<R2DriverOptions> = {}) =>
      new R2Driver({ binding: () => bucket, publicUrl: 'https://media.example.com', ...options })

    beforeEach(async () => {
      bucket ??= await harness.bucket()
      await harness.reset(bucket)
      driver = make()
    })

    describe('put/get', () => {
      test('stores and retrieves a string', async () => {
        await driver.put('test.txt', 'Hello, World!')
        expect((await driver.get('test.txt'))?.toString()).toBe('Hello, World!')
        expect(await driver.getAsString('test.txt')).toBe('Hello, World!')
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
        expect(await driver.allFiles('')).toEqual(['path/to/file.txt'])
      })

      test('round-trips contentType and custom metadata', async () => {
        await driver.put('a.json', '{}', { contentType: 'application/json', metadata: { owner: '42' } })
        const metadata = await driver.metadata('a.json')
        expect(metadata?.contentType).toBe('application/json')
        expect(metadata?.metadata).toEqual({ owner: '42' })
      })

      test('scopes every key under the prefix', async () => {
        const prefixed = make({ prefix: '/uploads/' })
        await prefixed.put('a.txt', 'x')
        expect(await driver.allFiles('uploads')).toEqual(['uploads/a.txt'])
        expect(await prefixed.getAsString('a.txt')).toBe('x')
        expect(prefixed.getPrefix()).toBe('uploads')
      })
    })

    describe.skipIf(!harness.streamingBody)('getStream', () => {
      test('streams the same bytes get() returns', async () => {
        await driver.put('stream.bin', Buffer.from('stream me, byte for byte'))
        const stream = await driver.getStream('stream.bin')
        expect(stream).not.toBeNull()
        expect(Buffer.from(await new Response(stream!).arrayBuffer()).toString()).toBe(
          'stream me, byte for byte',
        )
      })

      test('honours an inclusive byte range', async () => {
        await driver.put('range.bin', Buffer.from('0123456789'))
        const middle = await driver.getStream('range.bin', { range: { start: 2, end: 5 } })
        expect(Buffer.from(await new Response(middle!).arrayBuffer()).toString()).toBe('2345')

        const tail = await driver.getStream('range.bin', { range: { start: 7 } })
        expect(Buffer.from(await new Response(tail!).arrayBuffer()).toString()).toBe('789')
      })

      test('returns null for a missing key', async () => {
        expect(await driver.getStream('missing.bin')).toBeNull()
      })
    })

    test('putFile throws: Workers has no filesystem', async () => {
      await expect(driver.putFile('a.txt', '/tmp/a.txt')).rejects.toThrow(/no filesystem/)
    })

    test('exists reflects presence', async () => {
      await driver.put('test.txt', 'content')
      expect(await driver.exists('test.txt')).toBe(true)
      expect(await driver.exists('missing.txt')).toBe(false)
    })

    describe('delete/deleteMany', () => {
      test('delete returns true when the object existed and false when it did not', async () => {
        await driver.put('test.txt', 'content')
        expect(await driver.delete('test.txt')).toBe(true)
        expect(await driver.exists('test.txt')).toBe(false)
        expect(await driver.delete('test.txt')).toBe(false)
      })

      test('deleteMany returns 0 for no paths and deduplicates the rest', async () => {
        expect(await driver.deleteMany([])).toBe(0)
        await driver.put('a.txt', 'x')
        await driver.put('b.txt', 'y')
        expect(await driver.deleteMany(['a.txt', '/a.txt', 'a.txt/', 'b.txt'])).toBe(2)
        expect(await driver.allFiles('')).toEqual([])
      })
    })

    describe.skipIf(!harness.streamingBody)('copy/move', () => {
      test('copies bytes and metadata to the new key', async () => {
        await driver.put('src.txt', 'content', { contentType: 'text/plain', metadata: { k: 'v' } })
        expect(await driver.copy('src.txt', 'dst.txt')).toBe('dst.txt')
        expect(await driver.getAsString('dst.txt')).toBe('content')
        expect(await driver.getAsString('src.txt')).toBe('content')
        const copied = await driver.metadata('dst.txt')
        expect(copied?.contentType).toBe('text/plain')
        expect(copied?.metadata).toEqual({ k: 'v' })
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
      test('joins publicUrl, prefix and key, percent-encoding segments', () => {
        const prefixed = make({ publicUrl: 'https://media.example.com/', prefix: 'uploads' })
        expect(prefixed.url('/a/b.png')).toBe('https://media.example.com/uploads/a/b.png')
        expect(driver.url('a b/c#1.png')).toBe('https://media.example.com/a%20b/c%231.png')
      })

      test('throws without publicUrl', () => {
        expect(() => make({ publicUrl: undefined }).url('a.png')).toThrow(/publicUrl/)
      })
    })

    test('temporaryUrl throws with guidance when presign is not configured', async () => {
      const soon = new Date(Date.now() + 60_000)
      await expect(driver.temporaryUrl('a.png', soon)).rejects.toThrow(/presign/)
      await expect(driver.temporaryUrl('a.png', soon)).rejects.toThrow(/signed app route/)
    })

    describe('size/lastModified/metadata', () => {
      test('reads from head()', async () => {
        await driver.put('a.txt', 'hello', { contentType: 'text/plain', metadata: { k: 'v' } })
        expect(await driver.size('a.txt')).toBe(5)
        expect(await driver.lastModified('a.txt')).toBeInstanceOf(Date)
        const metadata = await driver.metadata('a.txt')
        expect(metadata?.lastModified).toBeInstanceOf(Date)
        // Exact, not a subset: an unexpected extra field or a dropped one is
        // the drift this assertion exists to catch. Only the timestamp is
        // excluded, since it differs per backend.
        expect({ ...metadata, lastModified: undefined }).toEqual({
          path: 'a.txt',
          size: 5,
          lastModified: undefined,
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
        const prefixed = make({ prefix: 'dir' })
        expect(await prefixed.files('')).toEqual(['file1.txt', 'file2.txt'])
        expect(await prefixed.directories('')).toEqual(['sub'])
        expect(await prefixed.allFiles('sub')).toEqual(['sub/deep/file4.txt', 'sub/file3.txt'])
      })

      test('does not list a directory marker as a file', async () => {
        await driver.makeDirectory('dir/empty')
        expect(await driver.directories('dir')).toEqual(['dir/empty', 'dir/sub'])
        expect(await driver.files('dir/empty')).toEqual([])
        expect(await driver.allFiles('dir/empty')).toEqual([])
      })
    })

    describe('deleteDirectory', () => {
      test('deletes everything under the directory and nothing beside it', async () => {
        await driver.put('dir/file1.txt', '1')
        await driver.put('dir/sub/file2.txt', '2')
        await driver.put('dir2/file3.txt', '3')

        await driver.deleteDirectory('dir')

        expect(await driver.allFiles('')).toEqual(['dir2/file3.txt'])
      })

      test('removes folder markers and respects the prefix', async () => {
        const prefixed = make({ prefix: 'app' })
        await prefixed.makeDirectory('dir/empty')
        await prefixed.put('dir/a.txt', '1')
        await driver.put('other/keep.txt', '')

        await prefixed.deleteDirectory('dir')

        expect(await prefixed.directories('')).toEqual([])
        expect(await driver.allFiles('')).toEqual(['other/keep.txt'])
      })
    })

    describe('visibility', () => {
      test('defaults to public when publicUrl is set and private otherwise', async () => {
        await driver.put('a.txt', 'x')
        expect(await driver.getVisibility('a.txt')).toBe('public')
        expect(await make({ publicUrl: undefined }).getVisibility('a.txt')).toBe('private')
      })

      test('accepts a matching visibility as a no-op', async () => {
        await driver.put('a.txt', 'x', { visibility: 'public' })
        await driver.setVisibility('a.txt', 'public')
        expect(await driver.getVisibility('a.txt')).toBe('public')
      })

      test('throws on a conflicting visibility instead of pretending', async () => {
        await expect(driver.put('a.txt', 'x', { visibility: 'private' })).rejects.toThrow(/no per-object visibility/)
        expect(await driver.exists('a.txt')).toBe(false)

        await driver.put('a.txt', 'x')
        await expect(driver.setVisibility('a.txt', 'private')).rejects.toThrow(/no per-object visibility/)
      })

      test('getVisibility/setVisibility throw for a missing file', async () => {
        await expect(driver.getVisibility('missing')).rejects.toThrow('File not found: missing')
        await expect(driver.setVisibility('missing', 'public')).rejects.toThrow('File not found: missing')
      })
    })
  })
}
