import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCloudflareOutput } from './build'

import { scaffoldApp, writeAgentModule, writeAgentsConfig } from '../tests/app-fixture'

/**
 * Every shape `renderWorkerModule` can emit. A cron trigger reaching a default
 * export with no `scheduled` does nothing at all and reports nothing, so the
 * table is exhaustive over the two flags rather than one case per feature —
 * agents-and-OAuth together is the shape nobody writes a test for by hand.
 */
const SHAPES = [
  { name: 'plain', agents: false, mcpOAuth: false },
  { name: 'agents', agents: true, mcpOAuth: false },
  { name: 'mcp-oauth', agents: false, mcpOAuth: true },
  { name: 'agents and mcp-oauth', agents: true, mcpOAuth: true },
] as const

describe('the generated worker dispatches cron triggers', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-cf-scheduled-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  for (const shape of SHAPES) {
    test(`should export scheduled for the ${shape.name} worker`, async () => {
      scaffoldApp(root, { agentsPlugin: shape.agents, mcpPlugin: shape.mcpOAuth, oauthProvider: shape.mcpOAuth })
      if (shape.agents) {
        writeAgentsConfig(root, { triager: { module: 'app/Agents/Triager.ts', export: 'Triager' } })
        writeAgentModule(root, 'app/Agents/Triager.ts', 'Triager')
      }

      await buildCloudflareOutput({ rootDir: root, skipAppBuild: true, mcpOAuth: shape.mcpOAuth })

      const worker = readFileSync(join(root, '.cloudflare/worker.js'), 'utf8')
      expect(worker).toContain('const handler = createWorkersHandler(app)')

      // The provider outranks the agent entry on requests, and neither carries
      // a scheduled of its own.
      const fetchEntry = shape.mcpOAuth ? 'oauth' : shape.agents ? 'agentEntry' : 'handler'
      expect(worker).toContain(`fetch: (request, env, ctx) => ${fetchEntry}.fetch(request, env, ctx)`)

      // Exact strings, not a matcher loose enough to accept either: the two
      // shapes that gained a sweep must not be able to drag the other two along.
      expect(worker).toContain(
        shape.mcpOAuth
          ? 'scheduled: async (event, env, ctx) => {\n    await sweepOAuthStorage(event, env)\n    await handler.scheduled(event, env, ctx)\n  },'
          : 'scheduled: (event, env, ctx) => handler.scheduled(event, env, ctx),',
      )
      expect(worker.includes('async function sweepOAuthStorage(')).toBe(shape.mcpOAuth)
    })
  }

  test('should sweep the OAuth key space before the app tasks, throttled and contained', async () => {
    scaffoldApp(root, { mcpPlugin: true, oauthProvider: true })

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true, mcpOAuth: true })

    const worker = readFileSync(join(root, '.cloudflare/worker.js'), 'utf8')

    // Nothing else removes an orphaned grant: it carries no expiry for a KV TTL
    // to act on, and the provider never calls its own sweep.
    expect(worker).toContain('const OAUTH_PURGE_BATCH = 100')
    // Two calls, because the provider returns from the grant phase as soon as it
    // fills its budget and the token phase behind it then never runs at all.
    expect(worker).toContain('purgeOrphanedTokens: false,')
    expect(worker).toContain('purgeOrphanedGrants: false,')
    expect(worker).toContain('purgeExpiredGrants: false,')

    // Under a prefix the provider never lists — it lists `client:`, `grant:` and
    // `token:` and nothing else, so the marker is invisible to the sweep itself.
    expect(worker).toContain("const OAUTH_PURGE_MARKER = 'guren:oauth-purge:last'")
    expect(worker).toContain('const OAUTH_PURGE_INTERVAL_MS = 3600000')
    expect(worker).toContain('if (last && elapsed >= 0 && elapsed < OAUTH_PURGE_INTERVAL_MS) return')

    // The marker is written after the sweep, so a firing that skipped it writes
    // nothing: a per-minute touch is 1440 KV writes a day against a tier of 1000.
    const purged = worker.indexOf('purgeExpiredData')
    const marked = worker.indexOf('OAUTH_PURGE_MARKER, String(now)')
    expect(purged).toBeGreaterThan(0)
    expect(marked).toBeGreaterThan(purged)

    // A sweep that throws must not take the app's tasks with it, and the sweep
    // runs first because an app whose cron exists for it binds no `scheduler`,
    // which `handler.scheduled` throws on by design.
    expect(worker).toContain("console.error('OAuth storage sweep failed.', error)")
    expect(worker.indexOf('await sweepOAuthStorage(event, env)')).toBeLessThan(
      worker.indexOf('await handler.scheduled(event, env, ctx)'),
    )
  })

  test('should scaffold no cron trigger, naming what a scheduled app has to add', async () => {
    scaffoldApp(root)

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    // A trigger every app pays for whether or not it has tasks is not scaffolded,
    // on the same rule as the OAuth KV namespace.
    const config = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')) as Record<string, unknown>
    expect(config.triggers).toBeUndefined()
  })
})

/**
 * The emitted sweep, lifted out of the generated worker and made callable. Its
 * free variables are `oauth` and `console`, so both are parameters. Evaluated
 * rather than imported because the sweep only exists as generator output, and
 * every assertion below would otherwise be a claim about its source text.
 */
function loadSweep(worker: string): {
  sweep: (event: unknown, env: unknown) => Promise<void>
  warnings: unknown[][]
  errors: unknown[][]
} {
  const start = worker.indexOf('const OAUTH_PURGE_MARKER')
  const end = worker.indexOf('export default {')
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)

  const warnings: unknown[][] = []
  const errors: unknown[][] = []
  const fake = {
    warn: (...args: unknown[]) => warnings.push(args),
    error: (...args: unknown[]) => errors.push(args),
  }

  // oxlint-disable-next-line no-new-func -- evaluating generator output is the point
  const factory = new Function('oauth', 'console', `${worker.slice(start, end)}\nreturn sweepOAuthStorage`)
  return { sweep: factory(oauthDouble, fake), warnings, errors }
}

/** Stands in for the `OAuthProvider` instance, recording what the sweep asked of it. */
const oauthDouble: { calls: unknown[]; results: unknown[]; throws?: Error } = {
  calls: [],
  results: [],
  purgeExpiredData(_env: unknown, options: unknown) {
    if (oauthDouble.throws) return Promise.reject(oauthDouble.throws)
    // Answers per call, so the grant phase can report capped while the token
    // phase behind it reports clean.
    const result = oauthDouble.results[oauthDouble.calls.length]
      ?? { done: true, grantsChecked: 0, grantsPurged: 0, tokensChecked: 0, tokensPurged: 0 }
    oauthDouble.calls.push(options)
    return Promise.resolve(result)
  },
} as never

/** Just the two KV methods the sweep reaches for, over a plain map. */
function fakeEnv(seed?: string): { OAUTH_KV: { get: unknown; put: unknown }; store: Map<string, string> } {
  const store = new Map<string, string>()
  if (seed !== undefined) store.set('guren:oauth-purge:last', seed)
  return {
    OAUTH_KV: {
      get: (key: string) => Promise.resolve(store.get(key) ?? null),
      put: (key: string, value: string) => {
        store.set(key, value)
        return Promise.resolve()
      },
    },
    store,
  }
}

describe('the emitted OAuth sweep', () => {
  let root: string
  let worker: string
  const HOUR = 3_600_000

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'guren-cf-sweep-'))
    scaffoldApp(root, { mcpPlugin: true, oauthProvider: true })
    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true, mcpOAuth: true })
    worker = readFileSync(join(root, '.cloudflare/worker.js'), 'utf8')
    oauthDouble.calls = []
    oauthDouble.results = []
    oauthDouble.throws = undefined
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('should sweep and record the run when no marker exists', async () => {
    const { sweep } = loadSweep(worker)
    const env = fakeEnv()

    await sweep({ scheduledTime: 1_000_000 }, env)

    expect(oauthDouble.calls).toEqual([
      { batchSize: 100, purgeOrphanedTokens: false },
      { batchSize: 100, purgeOrphanedGrants: false, purgeExpiredGrants: false },
    ])
    expect(env.store.get('guren:oauth-purge:last')).toBe('1000000')
  })

  test('should skip a firing inside the interval, leaving the marker alone', async () => {
    const { sweep } = loadSweep(worker)
    const env = fakeEnv('1000000')

    // A `* * * * *` app reaches here 59 more times before the next sweep is due.
    await sweep({ scheduledTime: 1_000_000 + HOUR - 60_000 }, env)

    expect(oauthDouble.calls).toEqual([])
    expect(env.store.get('guren:oauth-purge:last')).toBe('1000000')
  })

  test('should sweep once the interval has elapsed', async () => {
    const { sweep } = loadSweep(worker)
    const env = fakeEnv('1000000')

    await sweep({ scheduledTime: 1_000_000 + HOUR }, env)

    expect(oauthDouble.calls).toHaveLength(2)
    expect(env.store.get('guren:oauth-purge:last')).toBe(String(1_000_000 + HOUR))
  })

  test('should sweep past a marker it cannot read as a number', async () => {
    const { sweep } = loadSweep(worker)
    const env = fakeEnv('not-a-timestamp')

    await sweep({ scheduledTime: 1_000_000 }, env)

    // NaN fails the comparison, so an unreadable marker self-heals rather than
    // wedging the sweep off forever.
    expect(oauthDouble.calls).toHaveLength(2)
    expect(env.store.get('guren:oauth-purge:last')).toBe('1000000')
  })

  test('should sweep past a marker dated ahead of the firing', async () => {
    const { sweep } = loadSweep(worker)
    const env = fakeEnv(String(1_000_000 + HOUR))

    await sweep({ scheduledTime: 1_000_000 }, env)

    // A negative elapsed is under the interval too, so an unguarded comparison
    // would skip this firing and every one after it.
    expect(oauthDouble.calls).toHaveLength(2)
    expect(env.store.get('guren:oauth-purge:last')).toBe('1000000')
  })

  test('should report a failed sweep without rethrowing or recording it', async () => {
    oauthDouble.throws = new Error('KV unavailable')
    const { sweep, errors } = loadSweep(worker)
    const env = fakeEnv()

    // The app's own tasks run after this call and must still be reached.
    await sweep({ scheduledTime: 1_000_000 }, env)

    expect(errors).toHaveLength(1)
    // No marker: the next firing retries rather than waiting out the interval.
    expect(env.store.has('guren:oauth-purge:last')).toBe(false)
  })

  test('should name a sweep that stopped at its batch limit', async () => {
    oauthDouble.results = [
      { done: false, grantsChecked: 100, grantsPurged: 0, tokensChecked: 0, tokensPurged: 0 },
      { done: true, grantsChecked: 0, grantsPurged: 0, tokensChecked: 4, tokensPurged: 0 },
    ]
    const { sweep, warnings } = loadSweep(worker)

    await sweep({ scheduledTime: 1_000_000 }, fakeEnv())

    // Records past the window are unreachable for good, so a capped sweep is the
    // one thing an operator has to be told about.
    expect(warnings).toHaveLength(1)
  })
})
