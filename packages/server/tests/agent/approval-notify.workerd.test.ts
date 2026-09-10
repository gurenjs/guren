/**
 * The one claim a long-lived process cannot make: on workerd an approval
 * notification still in flight when the response is produced is abandoned with
 * the request context, silently, so `bun test` completes it and proves nothing.
 * Both directions run here — green with and without the deferral is not
 * evidence. Miniflare spawns workerd (a native binary), so it is gated behind
 * GUREN_TEST_WRANGLER=1 and skipped in CI, like the audit-emitter twin.
 */
import { describe, expect, test } from 'bun:test'

const enabled = process.env.GUREN_TEST_WRANGLER === '1'

describe.skipIf(!enabled)('the approval notification inside workerd', () => {
  test('should lose an undeferred notification and land a deferred one', async () => {
    const entry = new URL('./approval-notify.worker.ts', import.meta.url).pathname
    const build = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', minify: false })
    if (!build.success) {
      throw new Error(build.logs.map((log) => String(log)).join('\n'))
    }

    const { Miniflare } = await import('miniflare')
    const mf = new Miniflare({
      // An explicit module list: with `script` alone Miniflare walks the
      // bundle's import graph itself, which is stricter than what wrangler
      // ships to workerd.
      modules: [{ type: 'ESModule', path: 'worker.js', contents: await build.outputs[0]!.text() }],
      d1Databases: ['DB'],
      compatibilityDate: '2026-07-01',
      compatibilityFlags: ['nodejs_compat'],
    })

    try {
      const db = await mf.getD1Database('DB')
      await db.prepare('CREATE TABLE notified (tool TEXT)').run()

      for (const [tool, defer] of [['undeferred', '0'], ['deferred', '1']] as const) {
        const response = await mf.dispatchFetch(`http://localhost/?tool=${tool}&defer=${defer}`)
        expect(response.status).toBe(200)
        await response.arrayBuffer()
      }

      // Far longer than the channel's own delay: what is missing below is
      // missing because workerd dropped it, not because the assertion arrived early.
      await new Promise((done) => setTimeout(done, 1500))

      const rows = (await db.prepare('SELECT tool FROM notified').all()) as { results: { tool: string }[] }
      expect(rows.results.map((row) => row.tool)).toEqual(['deferred'])
    } finally {
      await mf.dispose()
    }
  }, 60_000)
})
