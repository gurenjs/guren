import { afterEach, describe, expect, it } from 'bun:test'
import type { FormEvent, ReactElement } from 'react'
import { router } from '@inertiajs/react'
import { createTypedForm, createTypedLink } from '../src/components'

const manifest = {
  'items.show': { method: 'GET', path: '/items/:id{[0-9]+}' },
  'archive.show': { method: 'GET', path: '/archive/:slug?' },
  'tags.show': { method: 'GET', path: '/tags/:code{[a-z]+}?' },
  'docs.meta': { method: 'GET', path: '/docs/:path{[^/]+}/meta' },
  'at.show': { method: 'GET', path: '/at/:t{[0-9]{2}}' },
  'files.show': { method: 'GET', path: '/files/:slug*' },
  'posts.pair': { method: 'GET', path: '/posts/:id/:idx' },
  'posts.index': { method: 'GET', path: '/posts' },
  'status.show': { method: 'GET', path: '/status/foo:bar' },
} as const

const Link = createTypedLink(manifest)
const Form = createTypedForm(manifest)

/** The element is inspected without rendering: `href` is computed in the factory. */
function hrefOf(element: ReactElement): string {
  return (element.props as { href: string }).href
}

describe('createTypedLink param substitution', () => {
  it.each([
    ['a regex-constrained param', Link({ route: 'items.show', params: { id: 7 } }), '/items/7'],
    ['an optional param', Link({ route: 'archive.show', params: { slug: 'news' } }), '/archive/news'],
    ['an optional regex-constrained param', Link({ route: 'tags.show', params: { code: 'abc' } }), '/tags/abc'],
    ['a constraint containing a slash character class', Link({ route: 'docs.meta', params: { path: 'intro' } }), '/docs/intro/meta'],
    ['a constraint with nested braces', Link({ route: 'at.show', params: { t: 12 } }), '/at/12'],
    ['a trailing * with the token', Link({ route: 'files.show', params: { slug: 'intro' } }), '/files/intro'],
    ['params sharing a prefix, without clobbering', Link({ route: 'posts.pair', params: { id: 1, idx: 2 } }), '/posts/1/2'],
    ['encoded values', Link({ route: 'archive.show', params: { slug: 'a b' } }), '/archive/a%20b'],
  ] as const)('substitutes %s', (_case, element, expected) => {
    expect(hrefOf(element)).toBe(expected)
  })

  it('treats a mid-segment colon as a literal, as Hono does', () => {
    expect(hrefOf(Link({ route: 'status.show' }))).toBe('/status/foo:bar')
  })

  it('keeps the path as-is for param-less routes', () => {
    expect(hrefOf(Link({ route: 'posts.index' }))).toBe('/posts')
  })

  it('throws on an unknown route name', () => {
    expect(() => Link({ route: 'missing' as never })).toThrow('Route [missing] not defined.')
  })
})

describe('createTypedForm param substitution', () => {
  const originalGet = (router as unknown as Record<string, unknown>).get
  const OriginalFormData = globalThis.FormData

  afterEach(() => {
    ;(router as unknown as Record<string, unknown>).get = originalGet
    globalThis.FormData = OriginalFormData
  })

  it('submits to the substituted action', () => {
    const element = Form({ route: 'items.show', params: { id: 7 }, method: 'get' })

    const calls: unknown[][] = []
    ;(router as unknown as Record<string, unknown>).get = (...args: unknown[]) => {
      calls.push(args)
    }
    // Bun has no DOM, so `new FormData(form)` needs a stand-in.
    globalThis.FormData = class {
      entries(): IterableIterator<[string, string]> {
        return [][Symbol.iterator]() as IterableIterator<[string, string]>
      }
    } as unknown as typeof FormData

    const onSubmit = (element.props as { onSubmit: (event: FormEvent<HTMLFormElement>) => void }).onSubmit
    onSubmit({ preventDefault() {}, currentTarget: {} } as unknown as FormEvent<HTMLFormElement>)

    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe('/items/7')
  })
})
