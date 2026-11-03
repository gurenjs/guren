import { describe, expect, it } from 'bun:test'
import type { GurenApplicationGraph } from '../src/application-graph'
import { joinExposure, placementOf } from '../src/dependency-exposure'
import { dependencyTree, readBunLock } from '../src/dependency-tree'
import type { FileImports, ImportScan } from '../src/import-scan'

const LOCK = `{
  "lockfileVersion": 2,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": { "@guren/core": "^1.26.0", "marked": "^16.0.0", "react-dom": "^19.0.0" },
      "devDependencies": { "vitest": "^5.0.0" },
    },
  },
  "packages": {
    "@guren/core": ["@guren/core@1.26.0", "", { "dependencies": { "hono": "^4.13.0" } }, "sha512-a=="],
    "hono": ["hono@4.13.13", "", {}, "sha512-b=="],
    "marked": ["marked@16.4.2", "", { "dependencies": { "entities": "^4.0.0" } }, "sha512-c=="],
    "entities": ["entities@4.5.0", "", {}, "sha512-d=="],
    "react-dom": ["react-dom@19.2.8", "", {}, "sha512-e=="],
    "vitest": ["vitest@5.0.5", "", {}, "sha512-f=="],
  },
}`

function tree() {
  const reading = readBunLock(LOCK)
  if (reading.kind !== 'read') throw new Error(reading.reason)
  return dependencyTree(reading.lock)
}

function scan(files: Record<string, Partial<FileImports>>, reasons: ImportScan['reasons'] = []): ImportScan {
  return {
    files: new Map(Object.entries(files).map(([file, entry]) => [file, { packages: entry.packages ?? [], files: entry.files ?? [] }])),
    reasons,
  }
}

const node = (kind: string, file: string | undefined, id = `${kind}:${file}`) => ({ id, kind, label: id, module: null, ...(file ? { file } : {}), evidence: [] })
const route = (id: string, method: string, path: string, action: string, authentication?: 'required') => ({
  id,
  kind: 'route',
  label: id,
  module: null,
  evidence: [],
  route: { method, path, name: id, action, order: 0, ...(authentication ? { authentication } : {}) },
})

function graph(complete = true): GurenApplicationGraph {
  return {
    schemaVersion: 1,
    snapshot: { id: 'graph-1', capturedAt: '2026-11-04T00:00:00.000Z', consistency: 'stable' },
    coverage: complete ? { handles: { status: 'complete', reasons: [] } } : { handles: { status: 'partial', reasons: [{ code: 'x', message: 'inline middleware' }] } },
    nodes: [
      route('posts.show', 'GET', '/posts/:id', 'show'),
      route('posts.store', 'POST', '/posts', 'store', 'required'),
      node('controller', 'app/Http/Controllers/PostController.ts'),
      node('page', 'resources/js/pages/posts/Show.tsx'),
    ],
    edges: [
      { from: 'posts.show', to: 'controller:app/Http/Controllers/PostController.ts', relation: 'handles', evidence: [] },
      { from: 'posts.store', to: 'controller:app/Http/Controllers/PostController.ts', relation: 'handles', evidence: [] },
      { from: 'controller:app/Http/Controllers/PostController.ts', to: 'page:resources/js/pages/posts/Show.tsx', relation: 'renders', evidence: [{ kind: 'static', source: 'controller:show' }] },
    ],
    unresolved: [],
  } as GurenApplicationGraph
}

const entry = (exposure: ReturnType<typeof joinExposure>, id: string) => {
  const found = exposure.packages.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`${id} missing`)
  return found
}

describe('placementOf', () => {
  it.each([
    ['app/Http/Controllers/PostController.ts', ['server']],
    ['resources/js/pages/posts/Show.tsx', ['client']],
    ['vite.config.ts', ['build']],
    ['scripts/seed.ts', ['build']],
    ['tests/controllers/PostController.test.ts', ['test']],
    ['app/Models/Post.test.ts', ['test']],
  ] as const)('places %p', (file, expected) => {
    expect(placementOf(file, new Set())).toEqual([...expected])
  })

  it('adds ssr to a client file the SSR entry reaches', () => {
    expect(placementOf('resources/js/pages/posts/Show.tsx', new Set(['resources/js/pages/posts/Show.tsx']))).toEqual(['client', 'ssr'])
  })
})

describe('joinExposure', () => {
  it('reaches the routes of a controller whose file imports the package through a service', () => {
    const exposure = joinExposure({
      tree: tree(),
      imports: scan({
        'app/Http/Controllers/PostController.ts': { files: ['app/Services/Render.ts'] },
        'app/Services/Render.ts': { packages: [{ name: 'marked', specifier: 'marked', line: 2 }] },
      }),
      graph: graph(),
    })

    const marked = entry(exposure, 'marked@16.4.2')
    expect(marked.attribution).toBe('routes')
    expect(marked.routes.map((reached) => `${reached.method} ${reached.path}`)).toEqual(['POST /posts', 'GET /posts/:id'])
    expect(marked.routes.find((reached) => reached.method === 'POST')?.authentication).toBe('required')
    expect(marked.importedBy).toEqual([{
      file: 'app/Services/Render.ts',
      line: 2,
      imports: 'marked',
      nodes: [{ node: 'controller:app/Http/Controllers/PostController.ts', kind: 'controller', chain: ['app/Http/Controllers/PostController.ts', 'app/Services/Render.ts'] }],
      entries: [],
    }])
    expect(entry(exposure, 'entities@4.5.0')).toMatchObject({ attribution: 'routes', placement: [{ at: 'server', evidence: 'import' }] })
  })

  it('reaches only the routes to the action that renders a page', () => {
    const exposure = joinExposure({
      tree: tree(),
      imports: scan({ 'resources/js/pages/posts/Show.tsx': { packages: [{ name: 'react-dom', specifier: 'react-dom', line: 1 }] } }),
      graph: graph(),
    })

    expect(entry(exposure, 'react-dom@19.2.8').routes.map((reached) => reached.path)).toEqual(['/posts/:id'])
  })

  it('reaches every page-rendering route from the client entry', () => {
    const exposure = joinExposure({
      tree: tree(),
      imports: scan({ 'resources/js/app.tsx': { packages: [{ name: 'react-dom', specifier: 'react-dom/client', line: 1 }] } }),
      graph: graph(),
    })

    const reactDom = entry(exposure, 'react-dom@19.2.8')
    expect(reactDom.routes.map((reached) => reached.path)).toEqual(['/posts/:id'])
    expect(reactDom.importedBy[0]?.entries).toEqual(['resources/js/app.tsx'])
  })

  it('attributes a package only @guren packages bring in to the framework, even though the app imports @guren/core', () => {
    const exposure = joinExposure({
      tree: tree(),
      imports: scan({ 'app/Http/Controllers/PostController.ts': { packages: [{ name: '@guren/core', specifier: '@guren/core', line: 1 }] } }),
      graph: graph(),
    })

    expect(entry(exposure, 'hono@4.13.13')).toMatchObject({ attribution: 'framework', importedBy: [], routes: [] })
    expect(entry(exposure, '@guren/core@1.26.0').attribution).toBe('routes')
  })

  it('finds no route for a package only tests import, whatever the graph reads', () => {
    const exposure = joinExposure({
      tree: tree(),
      imports: scan({ 'tests/setup.ts': { packages: [{ name: 'vitest', specifier: 'vitest', line: 1 }] } }),
      graph: graph(false),
    })

    expect(entry(exposure, 'vitest@5.0.5')).toMatchObject({ attribution: 'none-found', placement: [{ at: 'test', evidence: 'import' }] })
  })

  it('reads a served import with no route as unknown while the graph is incomplete, and none-found once it is complete', () => {
    const imports = scan({ 'app/Jobs/Digest.ts': { packages: [{ name: 'marked', specifier: 'marked', line: 1 }] } })

    expect(entry(joinExposure({ tree: tree(), imports, graph: graph(false) }), 'marked@16.4.2').attribution).toBe('unknown')
    expect(entry(joinExposure({ tree: tree(), imports, graph: graph() }), 'marked@16.4.2').attribution).toBe('none-found')
  })

  it('reads every package as unknown rather than unreached when the import scan is incomplete', () => {
    const exposure = joinExposure({
      tree: tree(),
      imports: scan({}, [{ code: 'unparsed', message: 'app/broken.ts could not be read or parsed, so its imports are unknown.' }]),
      graph: graph(),
    })

    expect(entry(exposure, 'marked@16.4.2').attribution).toBe('unknown')
    expect(exposure.coverage.imports.status).toBe('partial')
  })

  it('attributes nothing to a route and says so when there is no graph', () => {
    const exposure = joinExposure({
      tree: tree(),
      imports: scan({ 'app/Http/Controllers/PostController.ts': { packages: [{ name: 'marked', specifier: 'marked', line: 1 }] } }),
      graph: null,
    })

    expect(entry(exposure, 'marked@16.4.2')).toMatchObject({ attribution: 'unknown', routes: [] })
    expect(exposure.coverage.graph.status).toBe('unavailable')
    expect(exposure.coverage.runtime.status).toBe('unavailable')
  })
})
