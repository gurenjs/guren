import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { R2Driver, type R2BucketLike } from './R2Driver'

// Opt-in end-to-end test: runs the driver against workerd's real R2
// implementation through Miniflare's `getR2Bucket()`, so the semantics the
// in-memory `FakeR2Bucket` encodes (prefix/delimiter grouping, cursor
// pagination, folder markers, metadata round-trips) are checked against the
// runtime rather than assumed. Miniflare spawns workerd (a native binary
// fetched on install), so like wrangler-migrations.test.ts it is gated
// behind GUREN_TEST_WRANGLER=1 and skipped in CI.
const enabled = process.env.GUREN_TEST_WRANGLER === '1'

describe.skipIf(!enabled)('R2Driver against Miniflare R2', () => {
  let dispose: () => Promise<void>
  let bucket: R2BucketLike
  let driver: R2Driver

  beforeAll(async () => {
    const { Miniflare } = await import('miniflare')
    const mf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      r2Buckets: ['BUCKET'],
    })
    bucket = (await mf.getR2Bucket('BUCKET')) as unknown as R2BucketLike
    dispose = () => mf.dispose()
    driver = new R2Driver({ binding: () => bucket, publicUrl: 'https://media.example.com', prefix: 'app' })
  })

  afterAll(async () => {
    await dispose?.()
  })

  beforeEach(async () => {
    await driver.deleteDirectory('')
  })

  test('round-trips bytes, contentType and custom metadata', async () => {
    await driver.put('a/b.json', '{"k":1}', { contentType: 'application/json', metadata: { owner: '42' } })

    expect(await driver.getAsString('a/b.json')).toBe('{"k":1}')
    expect(await driver.exists('a/b.json')).toBe(true)
    const metadata = await driver.metadata('a/b.json')
    expect(metadata?.size).toBe(7)
    expect(metadata?.contentType).toBe('application/json')
    expect(metadata?.metadata).toEqual({ owner: '42' })
    expect(metadata?.lastModified).toBeInstanceOf(Date)
  })

  // copy()/move() are not exercised here: the driver streams `get().body`
  // straight into `put()`, which workerd supports but Miniflare's out-of-
  // process binding proxy cannot marshal (DataCloneError on the stream).
  // They are covered by the FakeR2Bucket unit tests; the streaming put is
  // the documented R2 pattern (`bucket.put(key, object.body)`).

  test('delete reports whether the object existed', async () => {
    await driver.put('x.txt', 'x')
    expect(await driver.delete('x.txt')).toBe(true)
    expect(await driver.delete('x.txt')).toBe(false)
  })

  test('files/directories/allFiles group by delimiter and strip the prefix', async () => {
    await driver.put('dir/file1.txt', '1')
    await driver.put('dir/file2.txt', '2')
    await driver.put('dir/sub/file3.txt', '3')
    await driver.put('other/file4.txt', '4')
    await driver.makeDirectory('dir/empty')

    expect(await driver.files('dir')).toEqual(['dir/file1.txt', 'dir/file2.txt'])
    expect(await driver.directories('dir')).toEqual(['dir/empty', 'dir/sub'])
    expect(await driver.directories('')).toEqual(['dir', 'other'])
    expect(await driver.allFiles('dir')).toEqual(['dir/file1.txt', 'dir/file2.txt', 'dir/sub/file3.txt'])
    expect(await driver.files('dir/empty')).toEqual([])
  })

  test('deleteMany and deleteDirectory clear more than one list page', async () => {
    // Above the 1000-key delete cap and, with limit forced low, above one
    // list page — both code paths the fake can only approximate.
    const paths = Array.from({ length: 1100 }, (_, index) => `bulk/${String(index).padStart(4, '0')}.txt`)
    for (const path of paths) await bucket.put(`app/${path}`, '')

    expect((await driver.allFiles('bulk')).length).toBe(1100)
    expect(await driver.deleteMany(paths.slice(0, 50))).toBe(50)
    await driver.deleteDirectory('bulk')
    expect(await driver.allFiles('bulk')).toEqual([])
  })
})
