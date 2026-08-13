import { describe, expect, it } from 'bun:test'
import type { ReactElement } from 'react'
import { createTypedLink } from '../src/components'

const manifest = {
  'items.show': { method: 'GET', path: '/items/:id{[0-9]+}' },
  'archive.show': { method: 'GET', path: '/archive/:slug?' },
  'tags.show': { method: 'GET', path: '/tags/:code{[a-z]+}?' },
  'docs.meta': { method: 'GET', path: '/docs/:path{[^/]+}/meta' },
  'posts.pair': { method: 'GET', path: '/posts/:id/:idx' },
  'posts.index': { method: 'GET', path: '/posts' },
  'foo.show': { method: 'GET', path: '/foo/:slug*' },
} as const

const Link = createTypedLink(manifest)

/** The element is inspected without rendering: `href` is computed in the factory. */
function hrefOf(element: ReactElement): string {
  return (element.props as { href: string }).href
}

describe('createTypedLink param substitution', () => {
  it('substitutes a regex-constrained param without leaking the constraint', () => {
    expect(hrefOf(Link({ route: 'items.show', params: { id: 7 } }))).toBe('/items/7')
  })

  it('substitutes an optional param without leaving the ? marker', () => {
    expect(hrefOf(Link({ route: 'archive.show', params: { slug: 'news' } }))).toBe('/archive/news')
  })

  it('substitutes an optional regex-constrained param', () => {
    expect(hrefOf(Link({ route: 'tags.show', params: { code: 'abc' } }))).toBe('/tags/abc')
  })

  it('substitutes a param whose constraint contains a slash character class', () => {
    expect(hrefOf(Link({ route: 'docs.meta', params: { path: 'intro' } }))).toBe('/docs/intro/meta')
  })

  it('does not clobber a longer param that shares a prefix', () => {
    expect(hrefOf(Link({ route: 'posts.pair', params: { id: 1, idx: 2 } }))).toBe('/posts/1/2')
  })

  // `:slug*` is not Hono wildcard syntax — its runtime param key really is
  // the literal `slug*` (verified directly against Hono; see
  // docs/*/guides/routing.md), so the substituted href must be keyed the
  // same way.
  it('substitutes a literal `:name*` param under its real Hono key (name + `*`)', () => {
    expect(hrefOf(Link({ route: 'foo.show', params: { 'slug*': 'x' } }))).toBe('/foo/x')
  })

  it('encodes substituted values', () => {
    expect(hrefOf(Link({ route: 'archive.show', params: { slug: 'a b' } }))).toBe('/archive/a%20b')
  })

  it('keeps the path as-is for param-less routes', () => {
    expect(hrefOf(Link({ route: 'posts.index' }))).toBe('/posts')
  })

  it('throws on an unknown route name', () => {
    expect(() => Link({ route: 'missing' as never })).toThrow('Route [missing] not defined.')
  })
})
