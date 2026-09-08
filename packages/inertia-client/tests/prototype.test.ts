import { beforeEach, describe, expect, it } from 'bun:test'
import { http, HttpCancelledError, HttpResponseError, type HttpRequestConfig, type Page } from '@inertiajs/core'
import { definePage } from '../src/contracts'
import {
  PROTOTYPE_STATE_KEY,
  apiRoutes,
  createPrototypeHttpClient,
  definePrototype,
  formDataToObject,
  isPrototypeDefinition,
  page,
  resolveInitialPage,
  type PrototypeStorage,
} from '../src/prototype'

const routeManifest = {
  'posts.index': { method: 'GET', path: '/posts' },
  'posts.show': { method: 'GET', path: '/posts/:id' },
  'posts.store': { method: 'POST', path: '/posts' },
  'posts.update': { method: 'PUT', path: '/posts/:id' },
  'docs.show': { method: 'GET', path: '/docs/:slug{.+}' },
  'external': { method: 'GET', path: '/external' },
  'loop': { method: 'GET', path: '/loop' },
  'missing': { method: 'GET', path: '/missing' },
} as const

interface ApiRoutes {
  'posts.store': { body: { title: string; body?: string } }
}

const pages = {
  posts: {
    Index: definePage('posts/Index').props<{ posts: { id: number; title: string }[] }>(),
    Show: definePage('posts/Show').props<{ post: { id: number; title: string } }>(),
  },
  docs: { Show: definePage('docs/Show').props<{ slug: string }>() },
  errors: { NotFound: definePage('errors/NotFound').props<{ status: number; message: string }>() },
}

class MemoryStorage implements PrototypeStorage {
  readonly map = new Map<string, string>()
  getItem(key: string) {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.map.set(key, value)
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
}

function buildPrototype(options: { notFound?: boolean } = {}) {
  return definePrototype({
    manifest: routeManifest,
    api: apiRoutes<ApiRoutes>(),
    shared: { auth: { user: { id: 1, name: 'Demo' } } },
    state: () => ({ posts: [{ id: 1, title: 'First' }] }),
    notFoundPage: options.notFound ? pages.errors.NotFound : undefined,
    routes: {
      'posts.index': ({ state, query }) =>
        page(pages.posts.Index, {
          posts: typeof query.q === 'string' ? state.posts.filter((p) => p.title.includes(query.q as string)) : state.posts,
        }),
      'posts.show': ({ state, params, notFound }) => {
        const post = state.posts.find((p) => p.id === Number(params.id))
        return post ? page(pages.posts.Show, { post }) : notFound()
      },
      'posts.store': ({ state, body, redirect, errors, flash }) => {
        if (!body.title) return errors({ title: 'Title is required.' })
        const post = { id: state.posts.length + 1, title: body.title }
        state.posts.push(post)
        flash('success', 'Created')
        return redirect('posts.show', { id: post.id })
      },
      'posts.update': ({ state, params, body, redirect }) => {
        const post = state.posts.find((p) => p.id === Number(params.id))
        if (post) post.title = (body as { title: string }).title
        return redirect('posts.show', { id: params.id })
      },
      'docs.show': ({ params }) => page(pages.docs.Show, { slug: params.slug }),
      'external': ({ location }) => location('https://example.com/'),
      'loop': ({ redirect }) => redirect('loop'),
    },
  })
}

function get(url: string, headers: Record<string, unknown> = {}): HttpRequestConfig {
  return { method: 'get', url: `http://localhost${url}`, headers: { 'X-Inertia': true, ...headers } }
}

function post(url: string, data: unknown, headers: Record<string, unknown> = {}): HttpRequestConfig {
  return { method: 'post', url: `http://localhost${url}`, data, headers: { 'X-Inertia': true, ...headers } }
}

function pageOf(response: { data: string }): Page {
  return JSON.parse(response.data) as Page
}

describe('definePrototype', () => {
  it('brands the definition so a plain object is rejected by the loader', () => {
    expect(isPrototypeDefinition(buildPrototype())).toBe(true)
    expect(isPrototypeDefinition({ manifest: routeManifest, routes: {} })).toBe(false)
  })
})

describe('createPrototypeHttpClient', () => {
  let storage: MemoryStorage

  beforeEach(() => {
    storage = new MemoryStorage()
  })

  it('answers a GET with a page carrying shared props, errors and Inertia headers', async () => {
    const client = createPrototypeHttpClient(buildPrototype(), { storage })

    const response = await client.request(get('/posts'))

    expect(response.status).toBe(200)
    expect(response.headers['x-inertia']).toBe('true')
    const answered = pageOf(response)
    expect(answered.component).toBe('posts/Index')
    expect(answered.url).toBe('/posts')
    expect(answered.version).toBeNull()
    expect(answered.props.posts).toEqual([{ id: 1, title: 'First' }])
    expect(answered.props.auth).toEqual({ user: { id: 1, name: 'Demo' } })
    expect(answered.props.errors).toEqual({})
    expect(answered.flash).toEqual({})
  })

  it('decodes path params and matches constrained multi-segment params like the server', async () => {
    const client = createPrototypeHttpClient(buildPrototype(), { storage })

    const show = pageOf(await client.request(get('/posts/1')))
    expect(show.component).toBe('posts/Show')

    const doc = pageOf(await client.request(get('/docs/guides/a%20b/intro')))
    expect(doc.props.slug).toBe('guides/a b/intro')
  })

  it('parses the query string, arrays included, and keeps it on the page url', async () => {
    const client = createPrototypeHttpClient(buildPrototype(), { storage })

    const answered = pageOf(await client.request(get('/posts?q=First&tags[]=a&tags[]=b')))

    expect(answered.props.posts).toEqual([{ id: 1, title: 'First' }])
    expect(answered.url).toBe('/posts?q=First&tags[]=a&tags[]=b')
  })

  it('follows a redirect after POST by answering the target page directly', async () => {
    const client = createPrototypeHttpClient(buildPrototype(), { storage })

    const response = await client.request(post('/posts', { title: 'Second' }))

    expect(response.status).toBe(200)
    const answered = pageOf(response)
    expect(answered.component).toBe('posts/Show')
    expect(answered.url).toBe('/posts/2')
    expect(answered.props.post).toEqual({ id: 2, title: 'Second' })
  })

  it('carries flash set during the mutating handler on the redirected page', async () => {
    const client = createPrototypeHttpClient(buildPrototype(), { storage })

    const answered = pageOf(await client.request(post('/posts', { title: 'Flashed' })))

    expect(answered.flash).toEqual({ success: 'Created' })
  })

  it('renders validation errors on the page the visit came from', async () => {
    const client = createPrototypeHttpClient(buildPrototype(), {
      storage,
      currentUrl: () => 'http://localhost/posts?q=First',
    })

    const response = await client.request(post('/posts', { title: '' }))

    expect(response.status).toBe(200)
    const answered = pageOf(response)
    expect(answered.component).toBe('posts/Index')
    expect(answered.url).toBe('/posts?q=First')
    expect(answered.props.errors).toEqual({ title: 'Title is required.' })
  })

  it('scopes errors to the error bag the visit named', async () => {
    const client = createPrototypeHttpClient(buildPrototype(), { storage, currentUrl: () => '/posts' })

    const answered = pageOf(await client.request(post('/posts', { title: '' }, { 'X-Inertia-Error-Bag': 'createPost' })))

    expect(answered.props.errors).toEqual({ createPost: { title: 'Title is required.' } })
  })

  it('honours method spoofing through a POST body', async () => {
    const client = createPrototypeHttpClient(buildPrototype(), { storage })

    const answered = pageOf(await client.request(post('/posts/1', { _method: 'put', title: 'Renamed' })))

    expect(answered.component).toBe('posts/Show')
    expect(answered.props.post).toEqual({ id: 1, title: 'Renamed' })
  })

  it('returns only the requested props on a partial reload of the same component', async () => {
    const client = createPrototypeHttpClient(buildPrototype(), { storage })

    const partial = pageOf(
      await client.request(get('/posts', { 'X-Inertia-Partial-Component': 'posts/Index', 'X-Inertia-Partial-Data': 'posts' })),
    )
    expect(Object.keys(partial.props).sort()).toEqual(['errors', 'posts'])

    const except = pageOf(
      await client.request(get('/posts', { 'X-Inertia-Partial-Component': 'posts/Index', 'X-Inertia-Partial-Except': 'posts' })),
    )
    expect(Object.keys(except.props).sort()).toEqual(['auth', 'errors'])

    const mismatch = pageOf(
      await client.request(get('/posts', { 'X-Inertia-Partial-Component': 'posts/Show', 'X-Inertia-Partial-Data': 'posts' })),
    )
    expect(Object.keys(mismatch.props).sort()).toEqual(['auth', 'errors', 'posts'])
  })

  it('answers an external location as a 409 without the x-inertia header', async () => {
    const client = createPrototypeHttpClient(buildPrototype(), { storage })

    const error = await client.request(get('/external')).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HttpResponseError)
    const response = (error as HttpResponseError).response
    expect(response.status).toBe(409)
    expect(response.headers['x-inertia-location']).toBe('https://example.com/')
    expect(response.headers['x-inertia']).toBeUndefined()
  })

  it('rejects an unmatched URL with the 404 JSON the server answers', async () => {
    const client = createPrototypeHttpClient(buildPrototype(), { storage })

    const error = await client.request(get('/nowhere')).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HttpResponseError)
    const response = (error as HttpResponseError).response
    expect(response.status).toBe(404)
    expect(response.headers['x-inertia']).toBeUndefined()
    expect(JSON.parse(response.data)).toMatchObject({ statusCode: 404 })
  })

  it('names the fixture file when a matched route has no entry', async () => {
    const client = createPrototypeHttpClient(buildPrototype(), { storage })

    const error = (await client.request(get('/missing')).catch((e: unknown) => e)) as HttpResponseError

    expect(JSON.parse(error.response.data).message).toContain('"missing"')
    expect(JSON.parse(error.response.data).message).toContain('resources/js/prototype/index.ts')
  })

  it('renders the configured not-found page as a 200 instead', async () => {
    const client = createPrototypeHttpClient(buildPrototype({ notFound: true }), { storage })

    const response = await client.request(get('/posts/99'))

    expect(response.status).toBe(200)
    expect(pageOf(response).component).toBe('errors/NotFound')
    expect(pageOf(response).props.status).toBe(404)
  })

  it('stops a redirect loop instead of recursing forever', async () => {
    const client = createPrototypeHttpClient(buildPrototype(), { storage })

    const error = (await client.request(get('/loop')).catch((e: unknown) => e)) as HttpResponseError

    expect(error.response.status).toBe(404)
    expect(JSON.parse(error.response.data).message).toContain('Redirect loop')
  })

  it('rejects with HttpCancelledError when the signal is aborted', async () => {
    const client = createPrototypeHttpClient(buildPrototype(), { storage })
    const controller = new AbortController()
    controller.abort()

    const error = await client.request({ ...get('/posts'), signal: controller.signal }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HttpCancelledError)
  })

  it('runs the public http request, response and error handlers around the answer', async () => {
    const client = createPrototypeHttpClient(buildPrototype(), { storage })
    const seen: string[] = []
    const offRequest = http.onRequest((config) => {
      seen.push(`request:${config.url}`)
      return config
    })
    const offResponse = http.onResponse((response) => {
      seen.push(`response:${response.status}`)
      return response
    })
    const offError = http.onError((error) => {
      seen.push(`error:${error.code}`)
    })

    try {
      await client.request(get('/posts'))
      await client.request(get('/nowhere')).catch(() => undefined)
    } finally {
      offRequest()
      offResponse()
      offError()
    }

    expect(seen).toEqual([
      'request:http://localhost/posts',
      'response:200',
      'request:http://localhost/nowhere',
      'error:ERR_HTTP_RESPONSE',
    ])
  })

  it('persists state under a versioned envelope and restores it in a new client', async () => {
    const first = createPrototypeHttpClient(buildPrototype(), { storage })
    await first.request(post('/posts', { title: 'Kept' }))

    expect(JSON.parse(storage.map.get(PROTOTYPE_STATE_KEY)!)).toMatchObject({ v: 1 })

    const second = createPrototypeHttpClient(buildPrototype(), { storage })
    const answered = pageOf(await second.request(get('/posts')))

    expect(answered.props.posts).toEqual([
      { id: 1, title: 'First' },
      { id: 2, title: 'Kept' },
    ])
  })

  it('ignores a stored envelope from another version', async () => {
    storage.setItem(PROTOTYPE_STATE_KEY, JSON.stringify({ v: 0, state: { posts: [] } }))
    const client = createPrototypeHttpClient(buildPrototype(), { storage })

    const answered = pageOf(await client.request(get('/posts')))

    expect(answered.props.posts).toEqual([{ id: 1, title: 'First' }])
  })

  it('strips and re-applies a subpath base', async () => {
    const client = createPrototypeHttpClient(buildPrototype(), { storage, base: '/demo/' })

    const answered = pageOf(await client.request(get('/demo/posts')))
    expect(answered.component).toBe('posts/Index')
    expect(answered.url).toBe('/demo/posts')

    const redirected = pageOf(await client.request(post('/demo/posts', { title: 'Based' })))
    expect(redirected.url).toBe('/demo/posts/2')
  })
})

describe('resolveInitialPage', () => {
  it('answers the page for the location the shell was opened at', async () => {
    const client = createPrototypeHttpClient(buildPrototype(), { storage: new MemoryStorage() })

    const initial = await resolveInitialPage(client, { pathname: '/posts/1', search: '' })

    expect(initial.component).toBe('posts/Show')
    expect(initial.url).toBe('/posts/1')
  })

  it('throws with the reason when nothing answers the location', async () => {
    const client = createPrototypeHttpClient(buildPrototype(), { storage: new MemoryStorage() })

    await expect(resolveInitialPage(client, { pathname: '/nowhere', search: '' })).rejects.toThrow(
      'No named route matches GET /nowhere',
    )
  })
})

describe('formDataToObject', () => {
  it('keeps repeated keys and name[] keys as arrays', () => {
    const data = new FormData()
    data.append('title', 'T')
    data.append('tags[]', 'a')
    data.append('tags[]', 'b')
    data.append('ids', '1')
    data.append('ids', '2')
    data.append('single[]', 'only')

    expect(formDataToObject(data)).toEqual({ title: 'T', tags: ['a', 'b'], ids: ['1', '2'], single: ['only'] })
  })
})
