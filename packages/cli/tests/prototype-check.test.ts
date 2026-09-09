import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { RouteDefinition } from '@guren/core'
import { runCheck } from '../src/check'
import type { CheckResult } from '../src/check-result'
import { ParseCache } from '../src/parse-cache'
import { checkPrototypeRoutes, fixtureRoutesFromAst } from '../src/prototype-check'
import { parseSourceFile } from '../src/parse-cache'
import { createTempWorkspace, writeWorkspaceFiles, type TempWorkspace } from './helpers'

function route(overrides: Partial<RouteDefinition> & Pick<RouteDefinition, 'path'>): RouteDefinition {
  return { method: 'GET', capabilities: {}, ...overrides }
}

const FIXTURE = `import { definePrototype, page } from '@guren/inertia-client/prototype'
import { pages } from '@/.guren/pages.gen'
import { routeManifest } from '@/.guren/routes.gen'

export default definePrototype({
  manifest: routeManifest,
  routes: {
    'posts.index': () => page(pages.posts.Index, { posts: [] }),
    'posts.show': ({ params }) => page(pages.posts.Show, { id: params.id }),
    "posts.store": ({ redirect }) => redirect('posts.index'),
  },
})
`

const APP_WITH_LOADER = `import { createApp } from '@guren/core'
export default createApp({ prototype: () => import('../resources/js/prototype/index.js') })
`
const APP_WITHOUT_LOADER = `import { createApp } from '@guren/core'
export default createApp({})
`

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace('guren-prototype-check-')
})

afterEach(async () => {
  await workspace.cleanup()
})

async function run(definitions: RouteDefinition[] | undefined, files: Record<string, string>): Promise<CheckResult[]> {
  await writeWorkspaceFiles(workspace.dir, files)
  return checkPrototypeRoutes({ cwd: workspace.dir, cache: new ParseCache(), definitions })
}

const keys = (results: CheckResult[]) => results.map((result) => result.key).sort()
const byKey = (results: CheckResult[], key: string) => results.find((result) => result.key === key)

describe('fixtureRoutesFromAst', () => {
  it('reads literal keys, quoted or not', () => {
    const ast = parseSourceFile(FIXTURE, 'index.ts')!
    expect([...fixtureRoutesFromAst(ast)!.names].sort()).toEqual(['posts.index', 'posts.show', 'posts.store'])
  })

  it('reports a spread or computed key as unreadable rather than empty', () => {
    const spread = parseSourceFile(`definePrototype({ routes: { ...shared, 'a': () => 1 } })`, 'index.ts')!
    expect(fixtureRoutesFromAst(spread)!.unreadable).toContain('spread')

    const computed = parseSourceFile(`definePrototype({ routes: { [name]: () => 1 } })`, 'index.ts')!
    expect(fixtureRoutesFromAst(computed)!.unreadable).toContain('computed')
  })

  it('returns null when nothing calls definePrototype', () => {
    expect(fixtureRoutesFromAst(parseSourceFile(`export default {}`, 'index.ts')!)).toBeNull()
  })
})

describe('checkPrototypeRoutes', () => {
  it('contributes nothing to an app with no fixture and no prototype route', async () => {
    expect(await run([route({ path: '/posts', name: 'posts.index' })], {})).toEqual([])
  })

  it('passes a fully wired app', async () => {
    const results = await run(
      [
        route({ path: '/posts', name: 'posts.index', prototype: true }),
        route({ path: '/posts/:id', name: 'posts.show', prototype: true }),
        route({ method: 'POST', path: '/posts', name: 'posts.store', prototype: true }),
      ],
      { 'resources/js/prototype/index.ts': FIXTURE, 'src/app.ts': APP_WITH_LOADER },
    )

    expect(results.every((result) => result.status === 'pass')).toBe(true)
    expect(keys(results)).toContain('prototype-app-wiring')
  })

  it('fails an unnamed prototype route and one the fixture does not answer', async () => {
    const results = await run(
      [
        route({ path: '/anon', prototype: true }),
        route({ path: '/orphan', name: 'orphan', prototype: true }),
        route({ path: '/posts', name: 'posts.index', prototype: true }),
        route({ path: '/posts/:id', name: 'posts.show', prototype: true }),
        route({ method: 'POST', path: '/posts', name: 'posts.store', prototype: true }),
      ],
      { 'resources/js/prototype/index.ts': FIXTURE, 'src/app.ts': APP_WITH_LOADER },
    )

    expect(byKey(results, 'prototype-route-unnamed:GET:/anon')?.status).toBe('fail')
    expect(byKey(results, 'prototype-route-unanswered:orphan')?.status).toBe('fail')
    expect(byKey(results, 'prototype-route-unanswered:orphan')?.message).toContain("no 'orphan' entry")
  })

  it('fails a fixture entry whose route no longer exists', async () => {
    const results = await run(
      [route({ path: '/posts', name: 'posts.index', prototype: true }), route({ path: '/posts/:id', name: 'posts.show', prototype: true })],
      { 'resources/js/prototype/index.ts': FIXTURE, 'src/app.ts': APP_WITH_LOADER },
    )

    expect(byKey(results, 'prototype-fixture-orphan:posts.store')?.status).toBe('fail')
  })

  it('fails when createApp() passes no prototype loader', async () => {
    const results = await run(
      [route({ path: '/posts', name: 'posts.index', prototype: true })],
      { 'resources/js/prototype/index.ts': FIXTURE, 'src/app.ts': APP_WITHOUT_LOADER },
    )

    expect(byKey(results, 'prototype-app-wiring')?.status).toBe('fail')
  })

  it('fails prototype routes with no fixture file at all', async () => {
    const results = await run([route({ path: '/posts', name: 'posts.index', prototype: true })], { 'src/app.ts': APP_WITH_LOADER })

    expect(byKey(results, 'prototype-fixture-missing')?.status).toBe('fail')
  })

  it('fails a prototype route that declares agent metadata', async () => {
    const results = await run(
      [route({ path: '/posts', name: 'posts.index', prototype: true, agent: { description: 'List' } })],
      { 'resources/js/prototype/index.ts': FIXTURE, 'src/app.ts': APP_WITH_LOADER },
    )

    expect(byKey(results, 'prototype-route-agent:posts.index')?.status).toBe('fail')
  })

  it('fails two named routes the matcher cannot tell apart', async () => {
    const results = await run(
      [route({ path: '/posts', name: 'posts.index', prototype: true }), route({ path: '/posts', name: 'posts.alias' })],
      { 'resources/js/prototype/index.ts': FIXTURE, 'src/app.ts': APP_WITH_LOADER },
    )

    expect(byKey(results, 'prototype-route-ambiguous:posts.alias')?.status).toBe('fail')
  })

  it('warns about named GET routes the prototype cannot reach', async () => {
    const results = await run(
      [route({ path: '/posts', name: 'posts.index', prototype: true }), route({ path: '/about', name: 'about' })],
      { 'resources/js/prototype/index.ts': FIXTURE, 'src/app.ts': APP_WITH_LOADER },
    )

    const warn = byKey(results, 'prototype-pages-unreachable')
    expect(warn?.status).toBe('warn')
    expect(warn?.message).toContain('about')
  })

  it('reports an unreadable fixture instead of passing it', async () => {
    const dynamic = FIXTURE.replace("'posts.index': () => page(pages.posts.Index, { posts: [] }),", '...extra,')
    const results = await run(
      [route({ path: '/posts', name: 'posts.index', prototype: true })],
      { 'resources/js/prototype/index.ts': dynamic, 'src/app.ts': APP_WITH_LOADER },
    )

    expect(byKey(results, 'prototype-fixture-unreadable')?.status).toBe('warn')
    expect(keys(results).some((key) => key.startsWith('prototype-route-unanswered'))).toBe(false)
  })

  it('fails a client entry that names a fixture module which does not exist', async () => {
    const results = await run([], {
      'resources/js/app.tsx': `startInertiaClient({ prototype: import.meta.env.GUREN_PROTOTYPE ? { load: () => import('./prototype/index.js') } : undefined })`,
    })

    expect(byKey(results, 'prototype-client-wiring')?.status).toBe('fail')
  })
})

describe('guren check --prototype', () => {
  it('runs the suite alone and sets no other check', async () => {
    await writeWorkspaceFiles(workspace.dir, {
      'resources/js/prototype/index.ts': FIXTURE,
      'src/app.ts': APP_WITH_LOADER,
    })

    const report = await runCheck({ cwd: workspace.dir, prototype: true })

    expect(report.checks.every((result) => result.key.startsWith('prototype-'))).toBe(true)
    // No routes file, so the entries cannot be judged and silence would be a vacuous pass.
    expect(report.checks.map((result) => result.key)).toEqual(['prototype-fixture-unverified'])
    expect(report.checks[0]?.message).toContain('3 entries')
  })
})
