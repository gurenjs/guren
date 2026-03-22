import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
    ]

    const content = buildDeclarationContent(definitions, { source: 'routes/web.ts' })

    expect(content).toContain("'GET'")
    expect(content).toContain("'POST'")
    expect(content).toContain("'PUT'")
    expect(content).toContain("'PATCH'")
    expect(content).toContain("'DELETE'")
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
})
