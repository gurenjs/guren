import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFreshContextApi } from '../src/fresh-context'
import { loadRouteDefinitions } from '../src/load-routes'

// These tests spawn the real CLI, so they are slower than the rest of the
// suite by design — running a child process is the whole behaviour under
// test. Fixtures import `Router` as a type only, so the temp app needs no
// resolvable node_modules (same trick as load-routes.test.ts).

const ROUTES_HEADER = `import type { Router } from '@guren/core'\n`

function routesFile(routeName: string, path: string): string {
  return `${ROUTES_HEADER}
export function registerWebRoutes(router: Router): void {
  router.get('${path}', () => new Response('ok')).name('${routeName}')
}
`
}

describe('createFreshContextApi', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'guren-cli-fresh-context-'))
    await mkdir(join(tempDir, 'routes'), { recursive: true })
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({ name: 'fixture-app' }))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns a project context with the routes of the app at cwd', async () => {
    await writeFile(join(tempDir, 'routes/web.ts'), routesFile('posts.index', '/posts'))

    const ctx = await createFreshContextApi().generateContext({ cwd: tempDir })

    expect(ctx.routes.map((route) => route.name)).toEqual(['posts.index'])
  }, 60_000)

  // The regression this module exists for: an in-process second call keeps
  // returning the module graph captured by the first one, because Bun keys
  // `.ts` modules on the resolved path and never re-evaluates them.
  it('picks up an edit to the routes file that an in-process reload misses', async () => {
    const file = join(tempDir, 'routes/web.ts')
    const api = createFreshContextApi()

    await writeFile(file, routesFile('posts.index', '/posts'))
    const before = await api.generateContext({ cwd: tempDir })
    const staleBefore = await loadRouteDefinitions(file, tempDir)

    await writeFile(file, routesFile('comments.index', '/comments'))
    const after = await api.generateContext({ cwd: tempDir })
    const staleAfter = await loadRouteDefinitions(file, tempDir)

    expect(before.routes.map((route) => route.name)).toEqual(['posts.index'])
    expect(after.routes.map((route) => route.name)).toEqual(['comments.index'])

    // Documents why the child process is necessary rather than optional.
    expect(staleBefore.map((route) => route.name)).toEqual(['posts.index'])
    expect(staleAfter.map((route) => route.name)).toEqual(['posts.index'])
  }, 60_000)

  it('rejects with the CLI error message when the entity does not exist', async () => {
    await writeFile(join(tempDir, 'routes/web.ts'), routesFile('posts.index', '/posts'))

    const promise = createFreshContextApi().generateEntityContext('NoSuchThing', { cwd: tempDir })

    await expect(promise).rejects.toThrow(/NoSuchThing/u)
  }, 60_000)

  // The child's stdout is not ours alone: anything the routes graph imports
  // can log to it while being evaluated (@guren/orm's duplicate-copy warning
  // does exactly this), which would otherwise break the parse.
  it('parses the payload even when a loaded module logs to stdout', async () => {
    await writeFile(
      join(tempDir, 'routes/web.ts'),
      `console.log('[some-dep] a warning nobody asked for')\n${routesFile('posts.index', '/posts')}`,
    )

    const ctx = await createFreshContextApi().generateContext({ cwd: tempDir })

    expect(ctx.routes.map((route) => route.name)).toEqual(['posts.index'])
  }, 60_000)

  // A noise line that itself starts with `{` (a JSON logger, a stray
  // `console.log(someObject)`) would fool a "first line starting with {"
  // extraction into slicing from the noise instead of the real payload —
  // the real payload is always the *last* such line, since nothing runs
  // after displayContext()'s single closing console.log.
  it('parses the payload even when the stdout noise itself looks like JSON', async () => {
    await writeFile(
      join(tempDir, 'routes/web.ts'),
      `console.log(JSON.stringify({ notThePayload: true }))\n${routesFile('posts.index', '/posts')}`,
    )

    const ctx = await createFreshContextApi().generateContext({ cwd: tempDir })

    expect(ctx.routes.map((route) => route.name)).toEqual(['posts.index'])
  }, 60_000)

  it('scopes an entity bundle to the requested module', async () => {
    await writeFile(join(tempDir, 'routes/web.ts'), routesFile('invoices.index', '/invoices'))
    await mkdir(join(tempDir, 'modules/billing/app/Models'), { recursive: true })
    await writeFile(
      join(tempDir, 'modules/billing/app/Models/Invoice.ts'),
      `import { Model } from '@guren/orm'
import { invoices } from '../../db/schema.js'

export class Invoice extends Model<typeof invoices> {
  static table = invoices
}
`,
    )

    const api = createFreshContextApi()

    expect(await api.generateEntityContext('Invoice', { cwd: tempDir, module: 'billing' }))
      .toMatchObject({ entity: 'Invoice' })

    // Proves the flag reaches the CLI rather than being silently dropped.
    await expect(
      api.generateEntityContext('Invoice', { cwd: tempDir, module: 'nope' }),
    ).rejects.toThrow(/module "nope"/u)
  }, 60_000)
})
