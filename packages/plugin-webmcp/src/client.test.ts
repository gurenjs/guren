/**
 * The WebMCP client's contract: which tools it registers, and what one
 * `execute` actually puts on the wire.
 *
 * Every fixture goes through the real `deriveAgentTools` on a real `Router`
 * rather than a hand-written tool object. A hand-written `inputSources` would
 * let a request-splitting bug pass here and fail against the manifest a real
 * app generates — the two have to be the same shape or these tests prove
 * nothing about the client.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { z } from 'zod'
import { Controller, Router, deriveAgentTools, authorizeMiddleware } from '@guren/core'
import {
  registerAgentTools,
  type ModelContextLike,
  type WebMcpToolDescriptor,
  type WebMcpToolSource,
} from './client'

class PostController extends Controller {
  async index() {
    return this.json({ posts: [] })
  }

  async store() {
    return this.created({})
  }

  async summary() {
    return this.json({ total: 3 })
  }
}

/**
 * Derive the manifest the way codegen does, then hand it over under the
 * structural type a generated `agentTools` satisfies.
 */
function manifest(register: (router: Router) => void): Record<string, WebMcpToolSource> {
  const router = new Router()
  register(router)
  const { tools } = deriveAgentTools(router.definitions())
  const entries: Record<string, WebMcpToolSource> = {}
  for (const tool of tools) {
    entries[tool.toolName] = tool
  }
  return entries
}

const handler = () => new Response('ok')

/** A GET with a query contract and a POST with a body contract, plus a path parameter. */
function standardManifest(): Record<string, WebMcpToolSource> {
  return manifest((router) => {
    router
      .get('/posts', { query: z.object({ page: z.coerce.number().optional() }) }, handler)
      .name('posts.index')
      .agent({ description: 'List posts.' })
    router
      .post(
        '/posts/:id/comments',
        { params: z.object({ id: z.coerce.number() }), body: z.object({ text: z.string() }) },
        handler,
      )
      .name('comments.store')
      .middleware(authorizeMiddleware('create-comment'))
      .agent({})
  })
}

interface RegisteredCall {
  descriptor: WebMcpToolDescriptor
}

/** A recording `modelContext`, standing in for the browser's. */
class FakeModelContext implements ModelContextLike {
  readonly calls: RegisteredCall[] = []
  readonly unregistered: string[] = []
  /** Tool names whose registration should throw, by name. */
  failOn = new Set<string>()
  /** Whether this host offers unregisterTool at all (the draft has churned). */
  supportsUnregister = true

  registerTool(descriptor: WebMcpToolDescriptor): unknown {
    if (this.failOn.has(descriptor.name)) {
      throw new Error(`duplicate tool name: ${descriptor.name}`)
    }
    this.calls.push({ descriptor })
    return undefined
  }

  unregisterTool(name: string): unknown {
    if (!this.supportsUnregister) throw new Error('unsupported')
    this.unregistered.push(name)
    return undefined
  }

  descriptor(name: string): WebMcpToolDescriptor {
    const found = this.calls.find((call) => call.descriptor.name === name)
    expect(found).toBeDefined()
    return found!.descriptor
  }
}

/**
 * A `fetch` that records what it was handed and answers canned.
 *
 * `requests` holds `new Request(input, init)` — what a real `fetch` derives
 * — not the Request the client passed in. The client depends on an init
 * carrying nothing but a signal leaving method, headers and body untouched;
 * recording the input directly would assert that claim against itself and
 * pass however the platform actually behaves.
 */
function recordingFetch(response: () => Response): {
  fetch: typeof fetch
  requests: Request[]
  inits: Array<RequestInit | undefined>
} {
  const requests: Request[] = []
  const inits: Array<RequestInit | undefined> = []
  const impl = (async (input: Request | string | URL, init?: RequestInit) => {
    inits.push(init)
    requests.push(new Request(input as Request, init))
    return response()
  }) as unknown as typeof fetch
  return { fetch: impl, requests, inits }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Install a `document` stub carrying a cookie string, and restore whatever
 * was there. bun:test has no DOM, and the CSRF read is a `document.cookie`
 * read by design — it is the same rule the generated API client applies, and
 * routing it through an injection seam would be testing a seam this module
 * would not otherwise have.
 */
const documentRestores: Array<() => void> = []

function stubDocument(value: unknown): void {
  const scope = globalThis as Record<string, unknown>
  const had = Object.hasOwn(scope, 'document')
  const previous = scope.document
  documentRestores.push(() => {
    if (had) scope.document = previous
    else delete scope.document
  })
  scope.document = value
}

afterEach(() => {
  for (const restore of documentRestores.splice(0).reverse()) restore()
})

describe('registerAgentTools', () => {
  test('should report an unsupported environment without throwing', async () => {
    // No anchor on document, none on navigator, none passed in: the ordinary
    // state of every browser that has not enabled the trial. A page calls
    // this on load, so it has to be a fact, not an exception.
    const registration = await registerAgentTools(standardManifest())

    expect(registration.supported).toBe(false)
    expect(registration.registered).toEqual([])
    await registration.unregister()
  })

  test('should find the anchor on document', async () => {
    const anchor = new FakeModelContext()
    stubDocument({ modelContext: anchor, cookie: '' })

    const registration = await registerAgentTools(standardManifest())

    expect(registration.supported).toBe(true)
    expect(registration.registered.sort()).toEqual(['comments.store', 'posts.index'])
  })

  test('should skip a tool the route excludes from webMcp', async () => {
    const anchor = new FakeModelContext()
    const tools = manifest((router) => {
      router.get('/posts', handler).name('posts.index').agent({})
      router.get('/internal', handler).name('internal.index').agent({ expose: { webMcp: false } })
    })

    const registration = await registerAgentTools(tools, { modelContext: anchor })

    expect(registration.registered).toEqual(['posts.index'])
    expect(registration.skipped).toEqual([{ tool: 'internal.index', reason: 'expose' }])
    expect(anchor.calls.map((call) => call.descriptor.name)).toEqual(['posts.index'])
  })

  test('should skip an approval-gated tool by default and register it on request', async () => {
    const tools = manifest((router) => {
      router.get('/posts', handler).name('posts.index').agent({})
      router
        .post('/payouts', handler)
        .name('payouts.store')
        .agent({ approval: 'required' })
    })

    const closed = new FakeModelContext()
    const byDefault = await registerAgentTools(tools, { modelContext: closed })
    expect(byDefault.registered).toEqual(['posts.index'])
    expect(byDefault.skipped).toEqual([{ tool: 'payouts.store', reason: 'approval' }])

    const opened = new FakeModelContext()
    const explicit = await registerAgentTools(tools, {
      modelContext: opened,
      includeApprovalRequired: true,
    })
    expect(explicit.registered.sort()).toEqual(['payouts.store', 'posts.index'])
    expect(explicit.skipped).toEqual([])
  })

  test('should advertise the description and annotations the manifest carries', async () => {
    const anchor = new FakeModelContext()
    await registerAgentTools(standardManifest(), { modelContext: anchor })

    const list = anchor.descriptor('posts.index')
    expect(list.description).toBe('List posts.')
    expect(list.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    })
    expect((list.inputSchema as { type: string }).type).toBe('object')

    const store = anchor.descriptor('comments.store')
    expect(store.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    })
  })

  test('should roll back the tools it already registered when one fails', async () => {
    const anchor = new FakeModelContext()
    anchor.failOn.add('comments.store')

    await expect(
      registerAgentTools(standardManifest(), { modelContext: anchor }),
    ).rejects.toThrow('duplicate tool name: comments.store')

    // posts.index registered first, so the page would otherwise be left with
    // half a catalogue and no result object to find it through.
    expect(anchor.calls.map((call) => call.descriptor.name)).toEqual(['posts.index'])
    expect(anchor.unregistered).toEqual(['posts.index'])
  })

  test('should unregister on request, and tolerate a host that cannot', async () => {
    const anchor = new FakeModelContext()
    const registration = await registerAgentTools(standardManifest(), { modelContext: anchor })
    await registration.unregister()
    expect(anchor.unregistered.sort()).toEqual(['comments.store', 'posts.index'])

    const older = new FakeModelContext()
    // A revision of the draft with no unregisterTool at all.
    const withoutUnregister: ModelContextLike = {
      registerTool: (descriptor) => older.registerTool(descriptor),
    }
    const second = await registerAgentTools(standardManifest(), {
      modelContext: withoutUnregister,
    })
    await second.unregister()
    expect(older.unregistered).toEqual([])
  })
})

describe('tool execution', () => {
  test('should dispatch a GET through the query string with no CSRF header', async () => {
    const anchor = new FakeModelContext()
    const wire = recordingFetch(() => json({ posts: [] }))
    stubDocument({ modelContext: anchor, cookie: 'XSRF-TOKEN=tok%20en' })

    await registerAgentTools(standardManifest(), { modelContext: anchor, fetch: wire.fetch })
    const result = await anchor.descriptor('posts.index').execute({ page: 2 })

    const request = wire.requests[0]!
    expect(request.method).toBe('GET')
    expect(new URL(request.url).pathname).toBe('/posts')
    // `page` is query-sourced in the manifest, so it belongs in the URL.
    expect(new URL(request.url).searchParams.get('page')).toBe('2')
    expect(request.headers.get('Accept')).toBe('application/json')
    expect(request.headers.get('X-Guren-Agent-Surface')).toBe('webmcp')
    // A safe method carries no token even with the cookie present.
    expect(request.headers.get('X-XSRF-TOKEN')).toBeNull()
    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toBe('{"posts":[]}')
  })

  test('should split a POST along inputSources and send the CSRF token', async () => {
    const anchor = new FakeModelContext()
    const wire = recordingFetch(() => json({ ok: true }, 201))
    stubDocument({ modelContext: anchor, cookie: 'other=1; XSRF-TOKEN=tok%20en' })

    await registerAgentTools(standardManifest(), { modelContext: anchor, fetch: wire.fetch })
    await anchor.descriptor('comments.store').execute({ id: 7, text: 'hello' })

    // Read off `new Request(built, { signal })`, the way a real fetch derives
    // it (see recordingFetch): method, headers and body all have to survive
    // an init that overrides none of them, or the client would be posting an
    // empty GET without anything here noticing.
    const request = wire.requests[0]!
    expect(request.method).toBe('POST')
    expect(new URL(request.url).pathname).toBe('/posts/7/comments')
    expect(request.headers.get('X-XSRF-TOKEN')).toBe('tok en')
    expect(request.headers.get('Content-Type')).toBe('application/json')
    expect(await request.json()).toEqual({ text: 'hello' })
  })

  test('should send no CSRF header when the cookie is absent', async () => {
    const anchor = new FakeModelContext()
    const wire = recordingFetch(() => json({ ok: true }))
    stubDocument({ modelContext: anchor, cookie: 'session=abc' })

    await registerAgentTools(standardManifest(), { modelContext: anchor, fetch: wire.fetch })
    await anchor.descriptor('comments.store').execute({ id: 1, text: 'hi' })

    // An app running csrf({ cookie: false }) has no token to send; an empty
    // header would turn a working call into a 403.
    expect(wire.requests[0]!.headers.get('X-XSRF-TOKEN')).toBeNull()
  })

  test('should unwrap a non-object body the derivation nested', async () => {
    const anchor = new FakeModelContext()
    const wire = recordingFetch(() => json({ ok: true }))
    const tools = manifest((router) => {
      router
        .post('/posts/bulk', { body: z.array(z.string()) }, handler)
        .name('posts.bulk')
        .agent({})
    })

    await registerAgentTools(tools, { modelContext: anchor, fetch: wire.fetch })
    await anchor.descriptor('posts.bulk').execute({ body: ['a', 'b'] })

    // The route validates the array itself; posting `{ body: [...] }` would
    // fail validation on a call the agent made correctly.
    expect(await wire.requests[0]!.json()).toEqual(['a', 'b'])
  })

  test('should carry structuredContent for a tool with an object output schema', async () => {
    const anchor = new FakeModelContext()
    const wire = recordingFetch(() => json({ total: 3 }))
    const tools = manifest((router) => {
      router
        .get('/posts/summary', { output: z.object({ total: z.number() }) }, [
          PostController,
          'summary',
        ])
        .name('posts.summary')
        .agent({})
    })

    await registerAgentTools(tools, { modelContext: anchor, fetch: wire.fetch })
    const result = await anchor.descriptor('posts.summary').execute({})

    expect(result.structuredContent).toEqual({ total: 3 })
    expect(result.isError).toBeUndefined()
  })

  test('should return only the MCP-shaped fields of a dispatch outcome', async () => {
    const anchor = new FakeModelContext()
    const wire = recordingFetch(() => json({ posts: [] }))

    await registerAgentTools(standardManifest(), { modelContext: anchor, fetch: wire.fetch })
    const result = await anchor.descriptor('posts.index').execute({})

    // `status` is for the App MCP endpoint's audit trail; a WebMCP host hands
    // whatever is returned straight to the agent, so it must not appear.
    expect(Object.keys(result)).toEqual(['content'])
  })

  test('should report a 422 as an error result carrying the body', async () => {
    const anchor = new FakeModelContext()
    const wire = recordingFetch(() =>
      json({ message: 'Validation failed', errors: { text: ['required'] } }, 422),
    )

    await registerAgentTools(standardManifest(), { modelContext: anchor, fetch: wire.fetch })
    const result = await anchor.descriptor('comments.store').execute({ id: 1 })

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('Validation failed')
  })

  test('should return an error result rather than rejecting on a network failure', async () => {
    const anchor = new FakeModelContext()
    const failing = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch

    await registerAgentTools(standardManifest(), { modelContext: anchor, fetch: failing })
    const result = await anchor.descriptor('posts.index').execute({})

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe('Request failed: Failed to fetch')
  })

  test('should name a missing path parameter instead of dispatching', async () => {
    const anchor = new FakeModelContext()
    const wire = recordingFetch(() => json({}))

    await registerAgentTools(standardManifest(), { modelContext: anchor, fetch: wire.fetch })
    const result = await anchor.descriptor('comments.store').execute({ text: 'hello' })

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe('Missing required path parameter(s): id.')
    // No URL could be built, so nothing may reach the network.
    expect(wire.requests).toEqual([])
  })

  test('should refuse a dot-segment path parameter', async () => {
    const anchor = new FakeModelContext()
    const wire = recordingFetch(() => json({}))

    await registerAgentTools(standardManifest(), { modelContext: anchor, fetch: wire.fetch })
    const result = await anchor.descriptor('comments.store').execute({ id: '..', text: 'x' })

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('may not be "." or ".."')
    expect(wire.requests).toEqual([])
  })

  test('should forward the abort signal to fetch', async () => {
    const anchor = new FakeModelContext()
    const wire = recordingFetch(() => json({ posts: [] }))
    const controller = new AbortController()

    await registerAgentTools(standardManifest(), { modelContext: anchor, fetch: wire.fetch })
    await anchor.descriptor('posts.index').execute({}, { signal: controller.signal })

    expect(wire.inits[0]?.signal).toBe(controller.signal)
  })
})
