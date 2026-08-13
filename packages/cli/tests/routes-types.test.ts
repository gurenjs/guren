import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { checkTypes, COLD_TSC_TIMEOUT } from './helpers'
import {
  buildDeclarationContent,
  buildRouteModuleContent,
  toTypeLiteral,
  type RouteDefinition,
} from '../src/routes-types'

describe('toTypeLiteral', () => {
  it('converts static path to quoted string', () => {
    expect(toTypeLiteral('/')).toBe("'/'")
    expect(toTypeLiteral('/users')).toBe("'/users'")
    expect(toTypeLiteral('/api/v1/health')).toBe("'/api/v1/health'")
  })

  it('converts dynamic segment to template literal', () => {
    expect(toTypeLiteral('/users/:id')).toBe('`/users/${string}`')
    expect(toTypeLiteral('/posts/:postId/comments')).toBe('`/posts/${string}/comments`')
  })

  it('handles multiple dynamic segments', () => {
    expect(toTypeLiteral('/users/:userId/posts/:postId')).toBe(
      '`/users/${string}/posts/${string}`',
    )
  })

  it('escapes single quotes in static paths', () => {
    expect(toTypeLiteral("/it's/path")).toBe("'/it\\'s/path'")
  })

  it('handles path without leading slash', () => {
    expect(toTypeLiteral('users/:id')).toBe('`/users/${string}`')
  })

  it('drops Hono regex constraints from dynamic segments', () => {
    expect(toTypeLiteral('/items/:id{[0-9]+}')).toBe('`/items/${string}`')
  })

  it('keeps segments intact when a constraint contains a slash', () => {
    expect(toTypeLiteral('/docs/:path{[^/]+}/meta')).toBe('`/docs/${string}/meta`')
  })
})

describe('buildDeclarationContent', () => {
  it('generates declaration with routes', () => {
    const definitions: RouteDefinition[] = [
      { method: 'GET', path: '/' },
      { method: 'GET', path: '/users' },
      { method: 'POST', path: '/users' },
    ]

    const content = buildDeclarationContent(definitions, { source: 'routes/web.ts' })

    expect(content).toContain('declare namespace Guren')
    expect(content).toContain("export type RouteMethod = 'GET' | 'POST'")
    expect(content).toContain("'/'")
    expect(content).toContain("'/users'")
  })

  it('includes source reference in header', () => {
    const definitions: RouteDefinition[] = [{ method: 'GET', path: '/' }]

    const content = buildDeclarationContent(definitions, { source: 'routes/web.ts' })

    expect(content).toContain('Generated from routes/web.ts')
    expect(content).toContain('DO NOT EDIT')
  })

  it('generates all HTTP methods', () => {
    const definitions: RouteDefinition[] = [
      { method: 'GET', path: '/resource' },
      { method: 'POST', path: '/resource' },
      { method: 'PUT', path: '/resource/:id' },
      { method: 'PATCH', path: '/resource/:id' },
      { method: 'DELETE', path: '/resource/:id' },
      { method: 'QUERY', path: '/resource/search' },
    ]

    const content = buildDeclarationContent(definitions, { source: 'routes/web.ts' })

    expect(content).toContain("'GET'")
    expect(content).toContain("'POST'")
    expect(content).toContain("'PUT'")
    expect(content).toContain("'PATCH'")
    expect(content).toContain("'DELETE'")
    expect(content).toContain("'QUERY'")
  })

  it('generates template literals for dynamic routes', () => {
    const definitions: RouteDefinition[] = [
      { method: 'GET', path: '/users/:userId/posts/:postId' },
    ]

    const content = buildDeclarationContent(definitions, { source: 'routes/web.ts' })

    expect(content).toContain('`/users/${string}/posts/${string}`')
  })

  it('deduplicates paths', () => {
    const definitions: RouteDefinition[] = [
      { method: 'GET', path: '/users' },
      { method: 'POST', path: '/users' },
      { method: 'DELETE', path: '/users' },
    ]

    const content = buildDeclarationContent(definitions, { source: 'routes/web.ts' })

    // '/users' should appear only once in RoutePath
    const matches = content.match(/'\/users'/g)
    expect(matches).toHaveLength(1)
  })

  it('augments Inertia types', () => {
    const definitions: RouteDefinition[] = [{ method: 'GET', path: '/' }]

    const content = buildDeclarationContent(definitions, { source: 'routes/web.ts' })

    expect(content).toContain("declare module '@inertiajs/react'")
    expect(content).toContain("declare module '@inertiajs/core'")
    expect(content).toContain('href: Guren.RouteUrl')
  })

  it('includes RouteUrl type with query string support', () => {
    const definitions: RouteDefinition[] = [{ method: 'GET', path: '/' }]

    const content = buildDeclarationContent(definitions, { source: 'routes/web.ts' })

    expect(content).toContain('export type RouteUrl = RoutePath | `${RoutePath}?${string}`')
  })

  it('sorts paths alphabetically', () => {
    const definitions: RouteDefinition[] = [
      { method: 'GET', path: '/zebra' },
      { method: 'GET', path: '/alpha' },
      { method: 'GET', path: '/beta' },
    ]

    const content = buildDeclarationContent(definitions, { source: 'routes/web.ts' })

    const alphaIndex = content.indexOf("'/alpha'")
    const betaIndex = content.indexOf("'/beta'")
    const zebraIndex = content.indexOf("'/zebra'")

    expect(alphaIndex).toBeLessThan(betaIndex)
    expect(betaIndex).toBeLessThan(zebraIndex)
  })

  it('sorts methods alphabetically', () => {
    const definitions: RouteDefinition[] = [
      { method: 'POST', path: '/' },
      { method: 'GET', path: '/' },
      { method: 'DELETE', path: '/' },
    ]

    const content = buildDeclarationContent(definitions, { source: 'routes/web.ts' })

    expect(content).toContain("export type RouteMethod = 'DELETE' | 'GET' | 'POST'")
  })

  it('handles empty path array gracefully', () => {
    const definitions: RouteDefinition[] = []

    const content = buildDeclarationContent(definitions, { source: 'routes/web.ts' })

    expect(content).toContain('export type RouteMethod = never')
    expect(content).toContain('export type RoutePath =\n    never')
  })
})

describe('buildRouteModuleContent', () => {
  it('generates a runtime manifest and route helpers for named routes', () => {
    const definitions: RouteDefinition[] = [
      { method: 'GET', path: '/', name: 'home' },
      { method: 'GET', path: '/posts/:id', name: 'posts.show' },
    ]

    const content = buildRouteModuleContent(definitions, { source: 'routes/web.ts' })

    expect(content).toContain("export const routeManifest = {")
    expect(content).toContain("'home': { method: 'GET', path: '/' }")
    expect(content).toContain("'posts.show': { method: 'GET', path: '/posts/:id' }")
    expect(content).toContain("export function route<TName extends RouteName>")
    expect(content).toContain("home: (query?: RouteQuery) => route('home', query)")
    expect(content).toContain("show: (params: RouteParams<'posts.show'>, query?: RouteQuery) => route('posts.show', params, query)")
  })

  it('emits no @ts-nocheck when no routes are named', () => {
    const content = buildRouteModuleContent([{ method: 'GET', path: '/' }], { source: 'routes/web.ts' })

    expect(content).not.toContain('@ts-nocheck')
  })

  // The empty manifest used to ship under `@ts-nocheck`, which made the
  // scaffolded app's typecheck skip this file entirely. Compiling both shapes
  // is what keeps that suppression from coming back as a hidden type error.
  it('type-checks under strict tsc with and without named routes', async () => {
    const ts = (await import('typescript')).default
    const dir = await mkdtemp(join(tmpdir(), 'guren-routes-types-'))
    try {
      const cases: Record<string, string> = {
        'empty-manifest.ts': buildRouteModuleContent(
          [{ method: 'GET', path: '/' }],
          { source: 'routes/web.ts' },
        ),
        'named-manifest.ts': buildRouteModuleContent(
          [
            { method: 'GET', path: '/', name: 'home' },
            { method: 'GET', path: '/posts/:id', name: 'posts.show' },
          ],
          { source: 'routes/web.ts' },
        ),
      }

      const files: string[] = []
      for (const [name, content] of Object.entries(cases)) {
        const path = join(dir, name)
        await writeFile(path, content, 'utf8')
        files.push(path)
      }

      const program = ts.createProgram(files, {
        strict: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
      })
      const diagnostics = ts.getPreEmitDiagnostics(program)

      expect(
        diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
      ).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/**
 * The generated module is app-facing code, so string assertions only prove it
 * mentions the right names. These run it (transpile, import, call `route()`)
 * and compile a usage probe against it, covering the one bug class both
 * gates exist for: Hono path modifiers (`{regex}`, `?`, `*`) leaking into
 * param keys or substituted URLs.
 */
describe('generated route() with Hono path modifiers', () => {
  const definitions: RouteDefinition[] = [
    { method: 'GET', path: '/items/:id{[0-9]+}', name: 'items.show' },
    { method: 'GET', path: '/archive/:slug?', name: 'archive.show' },
    { method: 'GET', path: '/tags/:code{[a-z]+}?', name: 'tags.show' },
    { method: 'GET', path: '/docs/:path{[^/]+}/meta', name: 'docs.meta' },
    { method: 'GET', path: '/posts/:id/:idx', name: 'posts.pair' },
    { method: 'GET', path: '/foo/:slug*', name: 'foo.show' },
  ]

  type RouteFn = (name: string, ...args: unknown[]) => string

  let dir: string
  let usageFile: string
  let route: RouteFn

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'guren-cli-routes-gen-'))
    usageFile = join(dir, 'usage.ts')
    const source = buildRouteModuleContent(definitions, { source: 'routes/web.ts' })
    const modulePath = join(dir, 'routes.gen.mjs')
    await Promise.all([
      writeFile(join(dir, 'routes.gen.ts'), source, 'utf8'),
      writeFile(usageFile, ROUTES_USAGE_PROBE, 'utf8'),
      writeFile(modulePath, new Bun.Transpiler({ loader: 'ts' }).transformSync(source), 'utf8'),
    ])
    ;({ route } = await import(pathToFileURL(modulePath).href))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('substitutes a regex-constrained param without leaking the constraint', () => {
    expect(route('items.show', { id: 7 })).toBe('/items/7')
  })

  it('substitutes an optional param without leaving the ? marker', () => {
    expect(route('archive.show', { slug: 'news' })).toBe('/archive/news')
  })

  it('substitutes an optional regex-constrained param', () => {
    expect(route('tags.show', { code: 'abc' })).toBe('/tags/abc')
  })

  it('substitutes a param whose constraint contains a slash character class', () => {
    expect(route('docs.meta', { path: 'intro' })).toBe('/docs/intro/meta')
  })

  it('does not clobber a longer param that shares a prefix', () => {
    expect(route('posts.pair', { id: 1, idx: 2 })).toBe('/posts/1/2')
  })

  it('substitutes a literal `:name*` param under its real Hono key (name + `*`)', () => {
    expect(route('foo.show', { 'slug*': 'x' })).toBe('/foo/x')
  })

  it('still appends the query string after a modifier substitution', () => {
    expect(route('items.show', { id: 7 }, { tab: 'specs' })).toBe('/items/7?tab=specs')
  })

  it('compiles the usage probe against the emitted module', () => {
    expect(checkTypes([usageFile], routesCompilerOptions)).toEqual([])
  }, COLD_TSC_TIMEOUT)
})

const ROUTES_USAGE_PROBE = `import { route, routes } from './routes.gen'

// Modifiers must normalize to the bare label in RouteParams keys, except a
// literal '*' (not a Hono modifier — see PATH_PARAM_TYPE_HELPERS), which
// stays part of the key.
void route('items.show', { id: 1 })
void route('archive.show', { slug: 'news' })
void route('tags.show', { code: 'abc' })
void route('docs.meta', { path: 'intro' })
void route('foo.show', { 'slug*': 'x' })
void routes.items.show({ id: 1 })

// @ts-expect-error the regex constraint must not leak into the param key
void route('items.show', { 'id{[0-9]+}': 1 })

// @ts-expect-error the optional marker must not leak into the param key
void route('archive.show', { 'slug?': 'news' })

// @ts-expect-error the bare name is not the real key — '*' is part of it
void route('foo.show', { slug: 'x' })

// @ts-expect-error a route with path params requires them
void route('items.show')
`

const routesCompilerOptions: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  // No @types scan: the default type-root walk climbs ancestor directories,
  // so a TMPDIR inside a workspace would silently pull in — and type-check —
  // every @types package it finds there.
  types: [],
}
