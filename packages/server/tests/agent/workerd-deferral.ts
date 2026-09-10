/**
 * The Miniflare harness both deferral suites run on. Shared because it encodes
 * runtime knowledge that has to move in lockstep — the compat date, the flags,
 * the explicit module list, the settle window — and both suites are gated behind
 * GUREN_TEST_WRANGLER=1 and skipped in CI, so a copy left behind when Miniflare
 * moves fails nowhere and is found by whoever next runs the suite locally.
 */

/**
 * Bundle `entry`, dispatch it twice inside workerd — once undeferred, once
 * deferred — and answer which of the two writes reached D1. Only the deferred
 * one may: green in both directions is the answer that proves nothing, which is
 * why the caller asserts the pair rather than a single row.
 */
export async function runDeferralCase(entry: string, table: string): Promise<string[]> {
  const build = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', minify: false })
  if (!build.success) {
    throw new Error(build.logs.map((log) => String(log)).join('\n'))
  }

  const { Miniflare } = await import('miniflare')
  const mf = new Miniflare({
    // An explicit module list: with `script` alone Miniflare walks the bundle's
    // import graph itself, which is stricter than what wrangler ships to workerd.
    modules: [{ type: 'ESModule', path: 'worker.js', contents: await build.outputs[0]!.text() }],
    d1Databases: ['DB'],
    compatibilityDate: '2026-07-01',
    compatibilityFlags: ['nodejs_compat'],
  })

  try {
    const db = await mf.getD1Database('DB')
    await db.prepare(`CREATE TABLE ${table} (tool TEXT)`).run()

    for (const [tool, defer] of [['undeferred', '0'], ['deferred', '1']] as const) {
      const response = await mf.dispatchFetch(`http://localhost/?tool=${tool}&defer=${defer}`)
      if (response.status !== 200) throw new Error(`worker answered ${response.status}`)
      await response.arrayBuffer()
    }

    // Far longer than the fixture's own delay: what is missing is missing
    // because workerd dropped it, not because the read arrived early.
    await new Promise((done) => setTimeout(done, 1500))

    const rows = (await db.prepare(`SELECT tool FROM ${table}`).all()) as { results: { tool: string }[] }
    return rows.results.map((row) => row.tool)
  } finally {
    await mf.dispose()
  }
}

/** Miniflare spawns workerd, a native binary, so both suites opt in explicitly. */
export const workerdEnabled = process.env.GUREN_TEST_WRANGLER === '1'
