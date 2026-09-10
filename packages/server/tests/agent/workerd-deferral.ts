/**
 * The Miniflare harness the deferral suites run on. Shared because it encodes
 * runtime knowledge that has to move in lockstep — the compat date, the flags,
 * the explicit module list, the settle window — and every suite is gated behind
 * GUREN_TEST_WRANGLER=1 and skipped in CI, so a copy left behind when Miniflare
 * moves fails nowhere and is found by whoever next runs the suite locally.
 */

/** One dispatch, sent as `?tool=<tool>&defer=<defer>`. */
export type DeferralCase = readonly [tool: string, defer: '0' | '1']

export interface DeferralOptions {
  cases?: readonly DeferralCase[]
  /** Binding name → the Durable Object class the fixture exports. */
  durableObjects?: Record<string, string>
}

const UNDEFERRED_THEN_DEFERRED: readonly DeferralCase[] = [['undeferred', '0'], ['deferred', '1']]

/**
 * Bundle `entry`, dispatch each case once inside workerd, and answer which
 * writes reached D1, sorted. The cases must include one expected to be dropped:
 * all-landed is the answer that proves nothing, which is why the caller asserts
 * the whole set rather than a single row.
 */
export async function runDeferralCase(
  entry: string,
  table: string,
  options: DeferralOptions = {},
): Promise<string[]> {
  const build = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    format: 'esm',
    minify: false,
    // Supplied by workerd at run time; there is nothing on disk to bundle.
    external: ['cloudflare:workers'],
  })
  if (!build.success) {
    throw new Error(build.logs.map((log) => String(log)).join('\n'))
  }

  const { Miniflare } = await import('miniflare')
  const mf = new Miniflare({
    // An explicit module list: with `script` alone Miniflare walks the bundle's
    // import graph itself, which is stricter than what wrangler ships to workerd.
    modules: [{ type: 'ESModule', path: 'worker.js', contents: await build.outputs[0]!.text() }],
    d1Databases: ['DB'],
    ...(options.durableObjects ? { durableObjects: options.durableObjects } : {}),
    compatibilityDate: '2026-07-01',
    compatibilityFlags: ['nodejs_compat'],
  })

  try {
    const db = await mf.getD1Database('DB')
    await db.prepare(`CREATE TABLE ${table} (tool TEXT)`).run()

    for (const [tool, defer] of options.cases ?? UNDEFERRED_THEN_DEFERRED) {
      const response = await mf.dispatchFetch(`http://localhost/?tool=${tool}&defer=${defer}`)
      if (response.status !== 200) throw new Error(`worker answered ${response.status} for ${tool}`)
      await response.arrayBuffer()
    }

    // Far longer than the fixture's own delay: what is missing is missing
    // because workerd dropped it, not because the read arrived early.
    await new Promise((done) => setTimeout(done, 1500))

    const rows = (await db.prepare(`SELECT tool FROM ${table}`).all()) as { results: { tool: string }[] }
    // Sorted because an alarm or a socket message lands in no dispatch order.
    return rows.results.map((row) => row.tool).sort()
  } finally {
    await mf.dispose()
  }
}

/** Miniflare spawns workerd, a native binary, so the suites opt in explicitly. */
export const workerdEnabled = process.env.GUREN_TEST_WRANGLER === '1'
