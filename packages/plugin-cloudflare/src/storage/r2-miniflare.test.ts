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

  // copy()/move() are exercised separately below: the driver streams
  // `get().body` straight into `put()`, which workerd supports but
  // Miniflare's out-of-process binding proxy cannot marshal (DataCloneError
  // on the stream) — so that path runs *inside* workerd, see the second
  // describe block.

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

// The streaming copy is the one code path the binding proxy cannot carry, so
// this block bundles the driver and runs it inside workerd itself, where
// `bucket.put(key, object.body)` is the documented R2 pattern.
describe.skipIf(!enabled)('R2Driver.copy/move inside workerd', () => {
  test('streams get().body into put() and carries metadata', async () => {
    const entry = new URL('./r2-miniflare.worker.ts', import.meta.url).pathname
    const build = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', minify: false })
    if (!build.success) {
      throw new Error(build.logs.map((log) => String(log)).join('\n'))
    }
    const script = await build.outputs[0]!.text()

    const { Miniflare } = await import('miniflare')
    const mf = new Miniflare({
      // An explicit module list: with `script` alone Miniflare walks the
      // bundle for imports and rejects the driver's dynamic
      // `import(moduleName)` for the optional aws4fetch dependency.
      modules: [{ type: 'ESModule', path: 'worker.js', contents: script }],
      r2Buckets: ['BUCKET'],
      compatibilityDate: '2026-07-01',
      compatibilityFlags: ['nodejs_compat'],
    })
    try {
      const response = await mf.dispatchFetch('http://worker/')
      const body = (await response.json()) as Record<string, unknown>
      expect(response.status).toBe(200)
      expect(body).toEqual({
        copied: 'content',
        bytesAreBuffer: true,
        bytes: Array.from(new TextEncoder().encode('content')),
        moved: 'content',
        copyExistsAfterMove: false,
        sourceExists: true,
        contentType: 'text/plain',
        metadata: { k: 'v' },
      })
    } finally {
      await mf.dispose()
    }
  })
})
