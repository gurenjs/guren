import { afterAll, describe, expect, test } from 'bun:test'
import type { Miniflare } from 'miniflare'
import { describeR2DriverConformance } from './r2-driver-conformance'
import { R2Driver, type R2BucketLike } from './R2Driver'

// Opt-in end-to-end test: runs the same driver contract as R2Driver.test.ts
// against workerd's real R2 through Miniflare's `getR2Bucket()`, so every
// semantic the in-memory `FakeR2Bucket` encodes is checked against the
// runtime rather than assumed. Miniflare spawns workerd (a native binary
// fetched on install), so like wrangler-migrations.test.ts it is gated
// behind GUREN_TEST_WRANGLER=1 and skipped in CI.
const enabled = process.env.GUREN_TEST_WRANGLER === '1'

let mf: Miniflare | undefined

afterAll(() => mf?.dispose())

async function miniflareBucket(): Promise<R2BucketLike> {
  const { Miniflare } = await import('miniflare')
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    r2Buckets: ['BUCKET'],
  })
  return (await mf.getR2Bucket('BUCKET')) as unknown as R2BucketLike
}

async function emptyBucket(bucket: R2BucketLike): Promise<void> {
  await new R2Driver({ binding: () => bucket }).deleteDirectory('')
}

if (enabled) {
  describeR2DriverConformance('R2Driver (Miniflare R2)', {
    bucket: miniflareBucket,
    reset: emptyBucket,
    // Miniflare's binding proxy cannot marshal `get().body` — the stream
    // copy() pipes into put() and getStream() returns to the caller; the
    // workerd block below runs those methods inside workerd instead.
    streamingBody: false,
  })
}

describe.skipIf(!enabled)('R2Driver against Miniflare R2 at scale', () => {
  test('deleteMany and deleteDirectory clear more than one list page', async () => {
    const bucket = mf ? ((await mf.getR2Bucket('BUCKET')) as unknown as R2BucketLike) : await miniflareBucket()
    await emptyBucket(bucket)
    const driver = new R2Driver({ binding: () => bucket, prefix: 'app' })
    // Above the 1000-key delete cap and above one list page — both code
    // paths the fake can only approximate.
    const paths = Array.from({ length: 1100 }, (_, index) => `bulk/${String(index).padStart(4, '0')}.txt`)
    for (let index = 0; index < paths.length; index += 100) {
      await Promise.all(paths.slice(index, index + 100).map((path) => bucket.put(`app/${path}`, '')))
    }

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
      // bundle's import graph itself, which is stricter than what wrangler
      // ships to workerd.
      modules: [{ type: 'ESModule', path: 'worker.js', contents: script }],
      r2Buckets: ['BUCKET'],
      compatibilityDate: '2026-07-01',
      compatibilityFlags: ['nodejs_compat'],
    })
    try {
      const response = await mf.dispatchFetch('http://worker/')
      const body = (await response.json()) as Record<string, unknown>
      expect(response.status).toBe(200)

      // The regression this block exists for: a signer the bundler cannot
      // reach makes temporaryUrl() throw `No such module` at runtime, which
      // nothing outside workerd can observe.
      const signedUrl = new URL(String(body.signedUrl))
      expect(signedUrl.origin).toBe('https://acct.r2.cloudflarestorage.com')
      expect(signedUrl.pathname).toBe('/b/a%20b.png')
      expect(signedUrl.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
      expect(signedUrl.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)

      const { signedUrl: _signed, ...rest } = body
      expect(rest).toEqual({
        copied: 'content',
        bytesAreBuffer: true,
        bytes: Array.from(new TextEncoder().encode('content')),
        streamedFull: 'content',
        // Inclusive start..end 1..3 of 'content' → offset 1, length 3.
        streamedRange: 'ont',
        missingStreamIsNull: true,
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
