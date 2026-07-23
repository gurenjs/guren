import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadRouteDefinitions } from '../src/load-routes'

// Module fixtures below export a plain object literal shaped like a
// GurenModule instead of calling the real `defineModule()` from
// `@guren/core` — `resolveGurenModule()`'s duck-typing accepts either.
// This keeps these tests independent of `@guren/core` being resolvable
// from a bare temp directory (it's a real workspace package with no
// node_modules entry outside the monorepo); `defineModule()` itself is
// covered separately by packages/server/tests/module.test.ts.

describe('loadRouteDefinitions', () => {
  let tempDir: string
  let originalCwd: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'guren-cli-load-routes-'))
    originalCwd = process.cwd()
    process.chdir(tempDir)
    await mkdir(join(tempDir, 'routes'), { recursive: true })
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await rm(tempDir, { recursive: true, force: true })
  })

  it('loads only the top-level routes file when no modules/ directory exists', async () => {
    await writeFile(
      join(tempDir, 'routes/web.ts'),
      `import type { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', () => new Response('ok')).name('posts.index')
}
`,
    )

    const definitions = await loadRouteDefinitions(join(tempDir, 'routes/web.ts'), tempDir)

    expect(definitions).toHaveLength(1)
    expect(definitions[0]?.name).toBe('posts.index')
  })

  it('merges routes from a prefixed module exporting a GurenModule object', async () => {
    await writeFile(
      join(tempDir, 'routes/web.ts'),
      `import type { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/', () => new Response('ok')).name('home')
}
`,
    )

    await mkdir(join(tempDir, 'modules/billing'), { recursive: true })
    await writeFile(
      join(tempDir, 'modules/billing/routes.ts'),
      `import type { Router } from '@guren/core'

export function registerBillingRoutes(router: Router): void {
  router.get('/', () => new Response('ok')).name('invoices.index')
  router.post('/', () => new Response('ok')).name('invoices.store')
}
`,
    )
    await writeFile(
      join(tempDir, 'modules/billing/index.ts'),
      `import { registerBillingRoutes } from './routes'

export const billingModule = {
  name: 'billing',
  prefix: '/invoices',
  providers: [],
  routes: registerBillingRoutes,
}
`,
    )

    const definitions = await loadRouteDefinitions(join(tempDir, 'routes/web.ts'), tempDir)
    const names = definitions.map((d) => d.name).sort()

    expect(names).toEqual(['home', 'invoices.index', 'invoices.store'])

    const storeRoute = definitions.find((d) => d.name === 'invoices.store')
    expect(storeRoute?.path).toBe('/invoices')
    expect(storeRoute?.method.toLowerCase()).toBe('post')
  })

  it('merges routes from a module with no prefix at the router root', async () => {
    await writeFile(
      join(tempDir, 'routes/web.ts'),
      `import type { Router } from '@guren/core'

export function registerWebRoutes(_router: Router): void {}
`,
    )

    await mkdir(join(tempDir, 'modules/health'), { recursive: true })
    await writeFile(
      join(tempDir, 'modules/health/index.ts'),
      `import type { Router } from '@guren/core'

export const healthModule = {
  name: 'health',
  providers: [],
  routes: (router: Router) => {
    router.get('/health', () => new Response('ok')).name('health.check')
  },
}
`,
    )

    const definitions = await loadRouteDefinitions(join(tempDir, 'routes/web.ts'), tempDir)

    expect(definitions).toHaveLength(1)
    expect(definitions[0]).toMatchObject({ name: 'health.check', path: '/health' })
  })

  it('merges routes from multiple modules independently', async () => {
    await writeFile(join(tempDir, 'routes/web.ts'), `import type { Router } from '@guren/core'\n\nexport function registerWebRoutes(_router: Router): void {}\n`)

    for (const [name, prefix] of [['billing', '/billing'], ['inventory', '/inventory']] as const) {
      await mkdir(join(tempDir, `modules/${name}`), { recursive: true })
      await writeFile(
        join(tempDir, `modules/${name}/index.ts`),
        `import type { Router } from '@guren/core'

export const ${name}Module = {
  name: '${name}',
  prefix: '${prefix}',
  providers: [],
  routes: (router: Router) => {
    router.get('/', () => new Response('ok')).name('${name}.index')
  },
}
`,
      )
    }

    const definitions = await loadRouteDefinitions(join(tempDir, 'routes/web.ts'), tempDir)
    const names = definitions.map((d) => d.name).sort()

    expect(names).toEqual(['billing.index', 'inventory.index'])
  })

  it('warns and skips a module directory without an index.ts, without throwing', async () => {
    await writeFile(join(tempDir, 'routes/web.ts'), `import type { Router } from '@guren/core'\n\nexport function registerWebRoutes(_router: Router): void {}\n`)

    await mkdir(join(tempDir, 'modules/incomplete'), { recursive: true })
    await writeFile(join(tempDir, 'modules/incomplete/.gitkeep'), '')

    const definitions = await loadRouteDefinitions(join(tempDir, 'routes/web.ts'), tempDir)

    expect(definitions).toEqual([])
  })

  it('warns and skips a module index.ts that does not export a GurenModule shape', async () => {
    await writeFile(join(tempDir, 'routes/web.ts'), `import type { Router } from '@guren/core'\n\nexport function registerWebRoutes(_router: Router): void {}\n`)

    await mkdir(join(tempDir, 'modules/broken'), { recursive: true })
    await writeFile(join(tempDir, 'modules/broken/index.ts'), `export const notAModule = { hello: 'world' }\n`)

    const definitions = await loadRouteDefinitions(join(tempDir, 'routes/web.ts'), tempDir)

    expect(definitions).toEqual([])
  })

  it('defaults appRoot to the routes file directory when omitted', async () => {
    await writeFile(
      join(tempDir, 'routes/web.ts'),
      `import type { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/', () => new Response('ok')).name('home')
}
`,
    )

    const definitions = await loadRouteDefinitions(join(tempDir, 'routes/web.ts'))

    expect(definitions.map((d) => d.name)).toEqual(['home'])
  })
})
