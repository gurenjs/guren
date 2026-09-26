import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadRouteDefinitions, resolveRoutesFile, withModuleNames } from '../src/load-routes'

// Module fixtures export a plain object shaped like a GurenModule rather than
// calling `defineModule()` — `resolveGurenModule()` duck-types either — so
// these tests need no `@guren/core` resolvable from a bare temp directory.

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

  it('records each definition\'s module directory and its defineModule() name apart', async () => {
    await writeFile(join(tempDir, 'routes/web.ts'), `import type { Router } from '@guren/core'\n\nexport function registerWebRoutes(router: Router): void {\n  router.get('/', () => new Response('ok'))\n}\n`)
    await mkdir(join(tempDir, 'modules/billing'), { recursive: true })
    await writeFile(
      join(tempDir, 'modules/billing/index.ts'),
      `import type { Router } from '@guren/core'

export default {
  name: 'Invoicing',
  providers: [],
  routes: (router: Router) => {
    router.get('/invoices', () => new Response('ok'))
  },
}
`,
    )

    const provenance: Array<string | null> = []
    const definitions = await loadRouteDefinitions(join(tempDir, 'routes/web.ts'), tempDir, undefined, provenance)

    expect(provenance).toEqual([null, 'billing'])
    expect(definitions.map((definition) => definition.module)).toEqual([undefined, 'Invoicing'])
  })

  it('loads a module whose entry is index.tsx', async () => {
    await writeFile(join(tempDir, 'routes/web.ts'), `import type { Router } from '@guren/core'\n\nexport function registerWebRoutes(_router: Router): void {}\n`)
    await mkdir(join(tempDir, 'modules/health'), { recursive: true })
    await writeFile(
      join(tempDir, 'modules/health/index.tsx'),
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
    const warnings: string[] = []

    const definitions = await loadRouteDefinitions(join(tempDir, 'routes/web.ts'), tempDir, warnings)

    expect(warnings).toEqual([])
    expect(definitions.map((definition) => definition.name)).toEqual(['health.check'])
  })

  it('names the file it resolved when the module entry exports no module', async () => {
    await writeFile(join(tempDir, 'routes/web.ts'), `import type { Router } from '@guren/core'\n\nexport function registerWebRoutes(_router: Router): void {}\n`)
    await mkdir(join(tempDir, 'modules/broken'), { recursive: true })
    await writeFile(join(tempDir, 'modules/broken/index.mts'), `export const notAModule = { hello: 'world' }\n`)
    const warnings: string[] = []

    await loadRouteDefinitions(join(tempDir, 'routes/web.ts'), tempDir, warnings)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toStartWith("modules/broken/index.mts doesn't export a defineModule() result")
  })

  it('warns and skips a module directory without an entry file, without throwing', async () => {
    await writeFile(join(tempDir, 'routes/web.ts'), `import type { Router } from '@guren/core'\n\nexport function registerWebRoutes(_router: Router): void {}\n`)

    await mkdir(join(tempDir, 'modules/incomplete'), { recursive: true })
    await writeFile(join(tempDir, 'modules/incomplete/.gitkeep'), '')
    const warnings: string[] = []

    const definitions = await loadRouteDefinitions(join(tempDir, 'routes/web.ts'), tempDir, warnings)

    expect(definitions).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toStartWith('modules/incomplete has no entry file (index or package.json main)')
  })

  it('warns and skips a module index.ts that does not export a GurenModule shape', async () => {
    await writeFile(join(tempDir, 'routes/web.ts'), `import type { Router } from '@guren/core'\n\nexport function registerWebRoutes(_router: Router): void {}\n`)

    await mkdir(join(tempDir, 'modules/broken'), { recursive: true })
    await writeFile(join(tempDir, 'modules/broken/index.ts'), `export const notAModule = { hello: 'world' }\n`)

    const definitions = await loadRouteDefinitions(join(tempDir, 'routes/web.ts'), tempDir)

    expect(definitions).toEqual([])
  })

  it('requires an explicit appRoot — dirname(routesFile) is not reliably the app root', async () => {
    // routes/web.ts's directory is "routes" and modules/ lives one level up,
    // so there is no correct default: appRoot is a required parameter.
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
      join(tempDir, 'modules/billing/index.ts'),
      `import type { Router } from '@guren/core'

export const billingModule = {
  name: 'billing',
  providers: [],
  routes: (router: Router) => {
    router.get('/invoices', () => new Response('ok')).name('invoices.index')
  },
}
`,
    )

    const definitions = await loadRouteDefinitions(join(tempDir, 'routes/web.ts'), tempDir)
    const names = definitions.map((d) => d.name).sort()

    expect(names).toEqual(['home', 'invoices.index'])
  })
})

describe('withModuleNames', () => {
  it('names the module on a definition an older server left unnamed, keeping one the server named', () => {
    const definitions = [
      { method: 'GET', path: '/' },
      { method: 'GET', path: '/invoices' },
      { method: 'GET', path: '/carts', module: 'Shop' },
    ]

    expect(withModuleNames(definitions, [null, 'Invoicing', 'Shopping']))
      .toEqual([{ method: 'GET', path: '/' }, { method: 'GET', path: '/invoices', module: 'Invoicing' }, { method: 'GET', path: '/carts', module: 'Shop' }])
  })
})

describe('resolveRoutesFile', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'guren-cli-resolve-routes-'))
    await mkdir(join(tempDir, 'routes'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('finds an api-only app’s routes/api.ts when no file is named', async () => {
    await writeFile(join(tempDir, 'routes/api.ts'), 'export function registerApiRoutes() {}\n')

    expect(await resolveRoutesFile(tempDir)).toEqual({ path: 'routes/api.ts', silentlyAbsent: false })
  })

  it('degrades silently to the default when the app has no entry at all', async () => {
    expect(await resolveRoutesFile(tempDir)).toEqual({ path: 'routes/web.ts', silentlyAbsent: true })
  })

  it('never degrades silently for a file the caller named', async () => {
    expect(await resolveRoutesFile(tempDir, 'routes/missing.ts')).toEqual({
      path: 'routes/missing.ts',
      silentlyAbsent: false,
    })
  })

  it('treats an empty name as unnamed', async () => {
    await writeFile(join(tempDir, 'routes/api.ts'), 'export function registerApiRoutes() {}\n')

    expect((await resolveRoutesFile(tempDir, '')).path).toBe('routes/api.ts')
  })
})
