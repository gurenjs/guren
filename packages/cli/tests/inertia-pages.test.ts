import { describe, expect, it } from 'bun:test'
import { extractInertiaPageRefs, expectedInertiaPagePath } from '../src/inertia-pages'

describe('extractInertiaPageRefs', () => {
  it('extracts string-literal references', () => {
    const refs = extractInertiaPageRefs(`
      class PostController {
        index() { return this.inertia('posts/Index', { posts: [] }) }
      }
    `)

    expect(refs).toEqual([{ id: 'posts/Index', form: 'literal' }])
  })

  it('extracts typed-manifest references', () => {
    const refs = extractInertiaPageRefs(`
      class PostController {
        show() { return this.inertia(pages.posts.Show, { post }) }
      }
    `)

    expect(refs).toEqual([{ id: 'posts/Show', form: 'manifest' }])
  })

  it('supports bracket segments in manifest references', () => {
    const refs = extractInertiaPageRefs(`
      class AdminController {
        index() { return this.inertia(pages['sales-admin'].Index, {}) }
      }
    `)

    expect(refs).toEqual([{ id: 'sales-admin/Index', form: 'manifest' }])
  })

  it('deduplicates repeated references', () => {
    const refs = extractInertiaPageRefs(`
      class PostController {
        a() { return this.inertia('posts/Index') }
        b() { return this.inertia('posts/Index') }
      }
    `)

    expect(refs).toHaveLength(1)
  })
})

describe('expectedInertiaPagePath', () => {
  it('points at the conventional .tsx location', () => {
    expect(expectedInertiaPagePath('posts/Index')).toBe('resources/js/pages/posts/Index.tsx')
  })
})
