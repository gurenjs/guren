import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { Container } from '../../src/container/Container'
import { Controller } from '../../src/mvc/Controller'
import { inertia } from '../../src/mvc/inertia/InertiaEngine'
import { defer, isDeferredProp, resolveInertiaProps, readPartialReload } from '../../src/mvc/inertia/props'
import { shareInertiaProps } from '../../src/mvc/inertia/shared'

type Page = { component: string; props: Record<string, unknown>; deferredProps?: Record<string, string[]> }

function inertiaRequest(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers: { 'X-Inertia': 'true', ...headers } })
}

async function pageOf(response: Response): Promise<Page> {
  return (await response.json()) as Page
}

describe('defer()', () => {
  test('marks a resolver with the default group', () => {
    const prop = defer(() => 1)

    expect(isDeferredProp(prop)).toBe(true)
    expect(prop.group).toBe('default')
  })

  test('keeps the group it was given', () => {
    expect(defer(() => 1, 'sidebar').group).toBe('sidebar')
  })

  test('recognises nothing else as deferred', () => {
    expect(isDeferredProp({ resolve: () => 1, group: 'default' })).toBe(false)
    expect(isDeferredProp(() => 1)).toBe(false)
    expect(isDeferredProp(null)).toBe(false)
  })
})

describe('readPartialReload()', () => {
  test('is a full visit without the X-Inertia header', () => {
    const request = new Request('http://example.com/posts', {
      headers: { 'X-Inertia-Partial-Component': 'posts/Index', 'X-Inertia-Partial-Data': 'posts' },
    })

    expect(readPartialReload(request, 'posts/Index')).toBeUndefined()
  })

  test('is a full visit when the partial component is another page', () => {
    const request = inertiaRequest('http://example.com/posts', {
      'X-Inertia-Partial-Component': 'posts/Show',
      'X-Inertia-Partial-Data': 'posts',
    })

    expect(readPartialReload(request, 'posts/Index')).toBeUndefined()
  })

  test('reads only and except as top-level prop names', () => {
    const request = inertiaRequest('http://example.com/posts', {
      'X-Inertia-Partial-Component': 'posts/Index',
      'X-Inertia-Partial-Data': 'posts, author.name,',
      'X-Inertia-Partial-Except': 'stats',
    })

    const partial = readPartialReload(request, 'posts/Index')
    expect([...partial!.only]).toEqual(['posts', 'author'])
    expect([...partial!.except]).toEqual(['stats'])
  })
})

describe('resolveInertiaProps()', () => {
  test('resolves lazy props and announces deferred ones on a full visit', async () => {
    const page = await resolveInertiaProps(
      {
        title: 'Posts',
        posts: () => Promise.resolve(['a']),
        comments: defer(() => ['c']),
        related: defer(() => ['r'], 'sidebar'),
        analytics: defer(async () => ({ views: 1 })),
      },
      undefined,
    )

    expect(page.props).toEqual({ title: 'Posts', posts: ['a'] })
    expect(page.deferredProps).toEqual({ default: ['comments', 'analytics'], sidebar: ['related'] })
  })

  test('omits deferredProps when nothing is deferred', async () => {
    const page = await resolveInertiaProps({ title: 'Posts' }, undefined)

    expect(page).toEqual({ props: { title: 'Posts' } })
  })

  test('narrows by only, then removes except, and keeps errors always', async () => {
    const page = await resolveInertiaProps(
      { posts: ['a'], stats: 1, errors: {}, auth: null },
      { only: new Set(['posts', 'stats']), except: new Set(['stats', 'errors']) },
    )

    expect(page.props).toEqual({ posts: ['a'], errors: {} })
  })

  test('sends everything but except when only is empty', async () => {
    const page = await resolveInertiaProps(
      { posts: ['a'], stats: 1, auth: null },
      { only: new Set(), except: new Set(['stats']) },
    )

    expect(page.props).toEqual({ posts: ['a'], auth: null })
  })

  test('resolves a deferred prop only when a partial reload selects it, and announces none', async () => {
    let resolved = 0
    const props = { posts: ['a'], comments: defer(() => ++resolved && ['c']) }

    const skipped = await resolveInertiaProps(props, { only: new Set(['posts']), except: new Set() })
    expect(skipped.props).toEqual({ posts: ['a'] })
    expect(skipped.deferredProps).toBeUndefined()
    expect(resolved).toBe(0)

    const selected = await resolveInertiaProps(props, { only: new Set(['comments']), except: new Set() })
    expect(selected.props).toEqual({ comments: ['c'] })
    expect(selected.deferredProps).toBeUndefined()
    expect(resolved).toBe(1)
  })

  test('propagates a resolver failure', async () => {
    const page = resolveInertiaProps({ posts: async () => { throw new Error('db down') } }, undefined)

    await expect(page).rejects.toThrow('db down')
  })

  test('never calls a lazy prop a partial reload leaves out', async () => {
    let calls = 0
    const page = await resolveInertiaProps(
      { posts: () => ['a'], companies: () => ++calls },
      { only: new Set(['posts']), except: new Set() },
    )

    expect(page.props).toEqual({ posts: ['a'] })
    expect(calls).toBe(0)
  })
})

describe('inertia() partial reloads and deferred props', () => {
  const props = () => ({
    posts: () => ['post'],
    companies: () => ['company'],
    comments: defer(() => ['comment']),
    errors: {},
  })

  test('narrows the props to the partial header on the same component', async () => {
    const request = inertiaRequest('http://example.com/posts', {
      'X-Inertia-Partial-Component': 'posts/Index',
      'X-Inertia-Partial-Data': 'posts',
    })

    const page = await pageOf(await inertia('posts/Index', props(), { request }))

    expect(page.props).toEqual({ posts: ['post'], errors: {} })
    expect(page.deferredProps).toBeUndefined()
  })

  test('sends every prop when the partial component does not match', async () => {
    const request = inertiaRequest('http://example.com/posts', {
      'X-Inertia-Partial-Component': 'posts/Show',
      'X-Inertia-Partial-Data': 'posts',
    })

    const page = await pageOf(await inertia('posts/Index', props(), { request }))

    expect(page.props).toEqual({ posts: ['post'], companies: ['company'], errors: {} })
    expect(page.deferredProps).toEqual({ default: ['comments'] })
  })

  test('announces deferred props on a full visit and resolves them on request', async () => {
    const first = await pageOf(await inertia('posts/Index', props(), { request: inertiaRequest('http://example.com/posts') }))
    expect(first.props).not.toHaveProperty('comments')
    expect(first.deferredProps).toEqual({ default: ['comments'] })

    const request = inertiaRequest('http://example.com/posts', {
      'X-Inertia-Partial-Component': 'posts/Index',
      'X-Inertia-Partial-Data': 'comments',
    })
    const followUp = await pageOf(await inertia('posts/Index', props(), { request }))
    expect(followUp.props).toEqual({ comments: ['comment'], errors: {} })
    expect(followUp.deferredProps).toBeUndefined()
  })

  test('embeds the announcement in the HTML document of a full page visit', async () => {
    const html = await (await inertia('posts/Index', props(), { url: '/posts' })).text()

    expect(html).toContain('"deferredProps":{"default":["comments"]}')
    expect(html).not.toContain('"comments":')
  })

  test('does not resolve a lazy prop on a version mismatch', async () => {
    let calls = 0
    const request = inertiaRequest('http://example.com/posts', { 'X-Inertia-Version': 'old' })

    const response = await inertia('posts/Index', { posts: () => ++calls }, { request, version: 'new' })

    expect(response.status).toBe(409)
    expect(calls).toBe(0)
  })
})

describe('Controller.inertia() partial reloads and deferred props', () => {
  class PostController extends Controller {
    static calls = { posts: 0, companies: 0, comments: 0 }

    async index() {
      return this.inertia('posts/Index', {
        posts: () => {
          PostController.calls.posts++
          return ['post']
        },
        companies: async () => {
          PostController.calls.companies++
          return ['company']
        },
        comments: defer(() => {
          PostController.calls.comments++
          return ['comment']
        }),
      })
    }
  }

  function createApp() {
    const container = new Container()
    shareInertiaProps(() => ({ auth: { user: 'jane' }, errors: {} }), container)
    const app = new Hono()
    app.get('/posts', async (c) => {
      const ctrl = new PostController()
      ctrl.setContext(c)
      ctrl.setContainer(container)
      return ctrl.index()
    })
    return app
  }

  async function request(headers: Record<string, string> = {}) {
    PostController.calls = { posts: 0, companies: 0, comments: 0 }
    const response = await createApp().request('/posts', { headers: { 'X-Inertia': 'true', ...headers } })
    const marker = (response as unknown as { __gurenInertia: { props: Record<string, unknown> } }).__gurenInertia
    return { page: await pageOf(response), marker }
  }

  test('sends shared and page props, announces the deferred one, and leaves it unresolved', async () => {
    const { page, marker } = await request()

    expect(page.props).toEqual({ auth: { user: 'jane' }, errors: {}, posts: ['post'], companies: ['company'] })
    expect(page.deferredProps).toEqual({ default: ['comments'] })
    expect(PostController.calls).toEqual({ posts: 1, companies: 1, comments: 0 })
    expect(marker.props).toEqual(page.props)
  })

  test('filters shared props by the partial header too, keeping errors', async () => {
    const { page } = await request({ 'X-Inertia-Partial-Component': 'posts/Index', 'X-Inertia-Partial-Data': 'posts' })

    expect(page.props).toEqual({ errors: {}, posts: ['post'] })
    expect(PostController.calls).toEqual({ posts: 1, companies: 0, comments: 0 })
  })

  test('sends everything when the partial component is another page', async () => {
    const { page } = await request({ 'X-Inertia-Partial-Component': 'posts/Show', 'X-Inertia-Partial-Data': 'posts' })

    expect(Object.keys(page.props).sort()).toEqual(['auth', 'companies', 'errors', 'posts'])
    expect(page.deferredProps).toEqual({ default: ['comments'] })
  })

  test('resolves the deferred prop on the follow-up partial reload', async () => {
    const { page, marker } = await request({
      'X-Inertia-Partial-Component': 'posts/Index',
      'X-Inertia-Partial-Data': 'comments',
    })

    expect(page.props).toEqual({ errors: {}, comments: ['comment'] })
    expect(page.deferredProps).toBeUndefined()
    expect(PostController.calls).toEqual({ posts: 0, companies: 0, comments: 1 })
    expect(marker.props).toEqual(page.props)
  })

  // An except-only reload selects everything else, the deferred prop included,
  // as the Laravel adapter does.
  test('drops the except list from a partial reload and resolves the rest', async () => {
    const { page } = await request({ 'X-Inertia-Partial-Component': 'posts/Index', 'X-Inertia-Partial-Except': 'companies' })

    expect(page.props).toEqual({ auth: { user: 'jane' }, errors: {}, posts: ['post'], comments: ['comment'] })
    expect(page.deferredProps).toBeUndefined()
    expect(PostController.calls).toEqual({ posts: 1, companies: 0, comments: 1 })
  })
})
