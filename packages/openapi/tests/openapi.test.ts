import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import * as z3 from 'zod/v3'
import { createApp, type RouteDefinition } from '@guren/core'
import {
  generateOpenApiDocument,
  mountOpenApiDocs,
  writeOpenApiDocument,
} from '../src/index'

describe('@guren/openapi', () => {
  it('generates an OpenAPI document from route definitions', () => {
    const definitions: RouteDefinition[] = [
      {
        method: 'POST',
        path: '/posts/:id',
        name: 'posts.store',
        summary: 'Create a post',
        description: 'Creates a new post.',
        tags: ['Posts'],
        operationId: 'postsStore',
        deprecated: true,
        schemas: {
          params: z.object({ id: z.coerce.number() }),
          query: z.object({ preview: z.boolean().optional() }),
          body: z.object({ title: z.string(), body: z.string() }),
          output: z.object({ id: z.number(), title: z.string(), body: z.string() }),
        },
      },
    ]

    const { document, warnings } = generateOpenApiDocument(definitions, {
      title: 'Blog API',
      version: '1.0.0',
      description: 'Docs',
      servers: ['https://example.com'],
    })

    expect(warnings).toEqual([])
    expect(document.info.title).toBe('Blog API')
    expect(document.paths['/posts/{id}']?.post?.summary).toBe('Create a post')
    expect(document.paths['/posts/{id}']?.post?.deprecated).toBe(true)
    expect(document.paths['/posts/{id}']?.post?.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'number' } },
      { name: 'preview', in: 'query', required: false, schema: { type: 'boolean' } },
    ])
    expect(document.paths['/posts/{id}']?.post?.requestBody?.content['application/json']?.schema).toEqual({
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['title', 'body'],
    })
    expect(document.paths['/posts/{id}']?.post?.responses['201']).toBeDefined()
    expect(document.paths['/posts/{id}']?.post?.responses['422']).toBeDefined()
  })

  it('keeps Hono path modifiers out of path templates, parameters, and operation ids', () => {
    // No `name`: operationId falls back to `name` when present, and these
    // routes have to exercise buildOperationId's own path-derived id.
    const definitions: RouteDefinition[] = [
      { method: 'GET', path: '/items/:id{[0-9]+}' },
      { method: 'GET', path: '/tags/:code{[a-z]+}?' },
      { method: 'GET', path: '/docs/:path{[^/]+}/meta' },
      // `:slug*` is not Hono wildcard syntax — its runtime param key is the
      // literal `slug*`. OpenAPI path templates follow RFC 6570, where
      // `{name*}` already means "explode", so the `*` is dropped here rather
      // than kept (unlike the TS/runtime param-key rule, which keeps it —
      // see PATH_PARAM_TYPE_HELPERS in @guren/cli's routes-types-fragments.ts).
      { method: 'GET', path: '/foo/:slug*' },
    ]

    const { document, warnings } = generateOpenApiDocument(definitions, {
      title: 'Blog API',
      version: '1.0.0',
    })

    expect(warnings).toEqual([])
    expect(Object.keys(document.paths).sort()).toEqual([
      '/docs/{path}/meta',
      '/foo/{slug}',
      '/items/{id}',
      '/tags/{code}',
    ])
    expect(document.paths['/items/{id}']?.get?.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ])
    expect(document.paths['/tags/{code}']?.get?.parameters).toEqual([
      { name: 'code', in: 'path', required: true, schema: { type: 'string' } },
    ])
    expect(document.paths['/foo/{slug}']?.get?.parameters).toEqual([
      { name: 'slug', in: 'path', required: true, schema: { type: 'string' } },
    ])
    expect(document.paths['/items/{id}']?.get?.operationId).toBe('getItemsById')
    expect(document.paths['/tags/{code}']?.get?.operationId).toBe('getTagsByCode')
    expect(document.paths['/foo/{slug}']?.get?.operationId).toBe('getFooBySlug')
  })

  it('returns warnings for non-zod schemas', () => {
    const definitions: RouteDefinition[] = [
      {
        method: 'GET',
        path: '/posts',
        schemas: {
          query: {
            parse: (value: unknown) => value,
            safeParse: () => ({ success: true as const, data: {} }),
          },
        },
      },
    ]

    const { warnings, document } = generateOpenApiDocument(definitions, {
      title: 'Blog API',
      version: '1.0.0',
    })

    expect(warnings[0]).toContain('skipped because schema is not a supported Zod schema')
    expect(document.paths['/posts']?.get?.parameters).toBeUndefined()
  })

  it('mounts OpenAPI json and Scalar docs on an application', async () => {
    const body = z.object({ title: z.string() })
    const output = z.object({ id: z.number(), title: z.string() })
    const app = createApp({
      routes(router) {
        router.post('/posts', {
          name: 'posts.store',
          body,
          output,
          summary: 'Create a post',
        }, async ({ body: payload }) => ({ id: 1, title: payload.title }))
      },
    })

    mountOpenApiDocs(app, {
      title: 'Blog API',
      version: '1.0.0',
    })

    await app.boot()

    const jsonResponse = await app.fetch(new Request('http://localhost/openapi.json'))
    expect(jsonResponse.status).toBe(200)
    const document = await jsonResponse.json() as { info: { title: string } }
    expect(document.info.title).toBe('Blog API')

    const docsResponse = await app.fetch(new Request('http://localhost/docs'))
    expect(docsResponse.status).toBe(200)
    const html = await docsResponse.text()
    expect(html).toContain('@scalar/api-reference')
    expect(html).toContain('/openapi.json')
  })

  it('skips methods OpenAPI 3.1 cannot express and says so in a warning', () => {
    const definitions: RouteDefinition[] = [
      { method: 'GET', path: '/posts', name: 'posts.index' },
      { method: 'QUERY', path: '/posts/search', name: 'posts.search' },
      { method: 'PURGE', path: '/cache', name: 'cache.purge' },
    ]

    const { document, warnings } = generateOpenApiDocument(definitions, {
      title: 'Blog API',
      version: '1.0.0',
    })

    expect(document.paths['/posts']?.get).toBeDefined()
    expect(document.paths['/posts/search']).toBeUndefined()
    expect(document.paths['/cache']).toBeUndefined()
    expect(warnings).toEqual([
      'Skipped QUERY /posts/search: OpenAPI 3.1 cannot express the QUERY method.',
      'Skipped PURGE /cache: OpenAPI 3.1 cannot express the PURGE method.',
    ])
  })

  it('surfaces skip warnings once when the document is served mounted', async () => {
    const app = createApp({
      routes(router) {
        router.get('/posts', { name: 'posts.index' }, async () => [])
        router.query('/posts/search', { name: 'posts.search' }, async () => [])
      },
    })

    mountOpenApiDocs(app, {
      title: 'Blog API',
      version: '1.0.0',
    })

    await app.boot()

    const warned: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warned.push(args.join(' ')) }
    try {
      const first = await app.fetch(new Request('http://localhost/openapi.json'))
      expect(first.status).toBe(200)
      const document = await first.json() as { paths: Record<string, unknown> }
      expect(document.paths['/posts/search']).toBeUndefined()

      const second = await app.fetch(new Request('http://localhost/openapi.json'))
      expect(second.status).toBe(200)
    } finally {
      console.warn = originalWarn
    }

    expect(warned).toEqual([
      '[guren/openapi] Skipped QUERY /posts/search: OpenAPI 3.1 cannot express the QUERY method.',
    ])
  })

  // An app only learns the address it serves on after it binds, so a mounted
  // document has to be able to pick the value up afterwards. Both fetches
  // matter: one alone passes just as well against a list frozen at mount.
  it('re-resolves a servers function on every mounted request', async () => {
    let serverUrl = 'http://localhost:3334'
    const app = createApp({
      routes(router) {
        router.get('/posts', { name: 'posts.index' }, async () => [])
      },
    })

    mountOpenApiDocs(app, {
      title: 'Blog API',
      version: '1.0.0',
      servers: () => [serverUrl],
    })

    await app.boot()

    const readServers = async () => {
      const response = await app.fetch(new Request('http://localhost/openapi.json'))
      expect(response.status).toBe(200)
      const document = await response.json() as { servers?: Array<{ url: string }> }
      return document.servers ?? []
    }

    expect(await readServers()).toEqual([{ url: 'http://localhost:3334' }])

    serverUrl = 'http://127.0.0.1:52341'

    expect(await readServers()).toEqual([{ url: 'http://127.0.0.1:52341' }])
  })

  // The pattern the example API uses, end to end over a real socket: `port: 0`
  // means nothing outside the app knows the port, so the document can only
  // name it by reading the address back off the app that bound it.
  it('names the address the app bound when servers reads app.address', async () => {
    const unbound = 'http://localhost:3334'
    const app = createApp({
      routes(router) {
        router.get('/posts', { name: 'posts.index' }, async () => [])
      },
    })

    mountOpenApiDocs(app, {
      title: 'Blog API',
      version: '1.0.0',
      servers: () => [app.address?.url ?? unbound],
    })

    await app.boot()

    const originalEnv = { ...process.env }
    process.env.GUREN_DEV_BANNER = '0'

    try {
      const address = await app.listen({ port: 0, hostname: '127.0.0.1', vite: false })

      const response = await fetch(`${address.url}/openapi.json`)
      expect(response.status).toBe(200)
      const document = await response.json() as { servers?: Array<{ url: string }> }
      expect(document.servers).toEqual([{ url: address.url }])
      // Guards the assertion above against a document that happens to match
      // because the app fell back to the placeholder.
      expect(address.url).not.toBe(unbound)
    } finally {
      process.env = { ...originalEnv }
      // `Application` has no public stop; the same reach-in appears in
      // packages/server's own port-binding tests.
      const server = (app as unknown as { bunServer?: { stop?: (close?: boolean) => unknown } })
        .bunServer
      await server?.stop?.(true)
    }
  })

  it('omits servers when a servers function resolves to an empty list', () => {
    const { document } = generateOpenApiDocument([], {
      title: 'Blog API',
      version: '1.0.0',
      servers: () => [],
    })

    expect(document.servers).toBeUndefined()
  })

  it('marks request bodies optional when an empty payload passes validation', () => {
    const definitions: RouteDefinition[] = [
      {
        method: 'PATCH',
        path: '/posts/:id',
        schemas: {
          body: z.object({
            title: z.string().optional(),
            body: z.string().default(''),
          }),
        },
      },
    ]

    const { document } = generateOpenApiDocument(definitions, {
      title: 'Blog API',
      version: '1.0.0',
    })

    expect(document.paths['/posts/{id}']?.patch?.requestBody?.required).toBe(false)
  })

  // zod 4 keeps an array's element in `_def.element` and the literal string
  // `'array'` in `_def.type` — reading the wrong key still produces a
  // document, just one with the element type missing. The zod 3 API, whose
  // `_def.type` holds a schema instead, is refused up front.
  describe('schema walking', () => {
    // `.pipe()` statically requires the target to accept the source's output,
    // but the walker reads whatever schema object it is handed at runtime.
    const pipeTo = (from: unknown, to: unknown) => (from as { pipe(target: unknown): unknown }).pipe(to)

    const operationFor = (schemas: Record<string, unknown>) => {
      const { document, warnings } = generateOpenApiDocument(
        [{ method: 'POST', path: '/posts', schemas }] as RouteDefinition[],
        { title: 'Blog API', version: '1.0.0' },
      )
      return { operation: document.paths['/posts']?.post, warnings }
    }

    const bodyDocument = (body: unknown) => {
      const { operation, warnings } = operationFor({ body })
      return { schema: operation?.requestBody?.content['application/json']?.schema, warnings }
    }

    const responseDocument = (output: unknown) => {
      const { operation, warnings } = operationFor({ output })
      return { schema: operation?.responses['201']?.content?.['application/json']?.schema, warnings }
    }

    const queryParameters = (query: unknown) => {
      const { operation, warnings } = operationFor({ query })
      return { parameters: operation?.parameters, warnings }
    }

    it('keeps the element type of a zod 4 array', () => {
      const { schema, warnings } = bodyDocument(z.object({ tags: z.array(z.string()) }))

      expect(schema?.properties?.tags).toEqual({ type: 'array', items: { type: 'string' } })
      expect(warnings).toEqual([])
    })

    // The zod 3 API is refused with a warning, not walked: on a v3 node
    // `_def.type` holds a nested schema where v4 keeps the type name, so
    // rendering it with v4 reads produces silently wrong output. `zod/v3`
    // ships inside zod 4 itself, so this arrives from apps declaring zod 4.
    it('refuses a zod 3 schema with a warning naming the zod v3 API', () => {
      const asBody = bodyDocument(z3.object({ tags: z3.array(z3.string()) }))
      expect(asBody.schema).toBeUndefined()
      expect(asBody.warnings).toHaveLength(1)
      expect(asBody.warnings[0]).toContain('zod v3 API')

      const asQuery = queryParameters(z3.object({ page: z3.number() }))
      expect(asQuery.parameters).toBeUndefined()
      expect(asQuery.warnings.some((w) => w.includes('zod v3 API'))).toBe(true)
    })

    // A v3 node inside a v4 object passes the entry gate (the object is v4).
    // Two things must hold: the walk refuses the nested node with the v3
    // warning, and the document still generates — `safeParse` on such an
    // object THROWS in zod 4 rather than returning a failure, so the
    // request-body required probe has to survive it.
    it('survives a v3 node nested inside a v4 body and names it in a warning', () => {
      const body = z.object({ legacy: z3.string() as never, ok: z.number() })
      const { operation, warnings } = operationFor({ body })

      const schema = operation?.requestBody?.content['application/json']?.schema
      expect(schema?.properties?.ok).toEqual({ type: 'number' })
      expect(schema?.properties?.legacy).toBeUndefined()
      expect(warnings.some((w) => w.includes('body.legacy') && w.includes('zod v3 API'))).toBe(true)
    })

    // A v4 wrapper around a v3 object also passes the entry gate; the
    // recursive unwrap has to re-check, or the only diagnostic is the generic
    // "expected an object schema".
    it('names the zod v3 API when a wrapped query schema hides a v3 object', () => {
      const { warnings } = queryParameters(z.optional(z3.object({ page: z3.number() }) as never))

      expect(warnings.some((w) => w.includes('zod v3 API'))).toBe(true)
    })

    // A pipe carries two types: `_def.in` is what a caller sends, `_def.out`
    // what the controller returns. Requests and responses need opposite sides.
    it('reports each side of a pipe to the message that carries it', () => {
      expect(bodyDocument(z.object({ page: z.string().pipe(z.coerce.number()) })).schema?.properties?.page)
        .toEqual({ type: 'string' })
      expect(responseDocument(z.object({ page: z.string().pipe(z.coerce.number()) })).schema?.properties?.page)
        .toEqual({ type: 'number' })
    })

    // `.transform()` is a pipe whose out side is an opaque function, so there
    // is no parsed type to recover — the in side stays the best answer.
    it('falls back to the in side of a transform', () => {
      const { schema } = responseDocument(z.object({ title: z.string() }).transform((value) => value.title))

      expect(schema).toEqual({ type: 'object', properties: { title: { type: 'string' } }, required: ['title'] })
    })

    // A default is filled in when the field is missing, so a caller may omit
    // it but a response always carries it. `prefault` behaves the same way.
    it('requires a filled-in field in a response but not in a request', () => {
      for (const schema of [
        () => z.object({ body: z.string().default('') }),
        () => z.object({ body: z.string().prefault('') }),
      ]) {
        expect(bodyDocument(schema()).schema?.required).toBeUndefined()
        expect(responseDocument(schema()).schema?.required).toEqual(['body'])
      }
    })

    it('requires a non-optional field in both directions', () => {
      const schema = () => z.object({ body: z.string().optional().nonoptional() })

      expect(bodyDocument(schema()).schema?.required).toEqual(['body'])
      expect(responseDocument(schema()).schema?.required).toEqual(['body'])
    })

    // `nullable` is the one single-child wrapper the type walk must NOT look
    // through: it renders as a union with null rather than passing its inner
    // schema out unchanged. It shares a membership list with the wrappers that
    // are looked through, so the exception has to be asserted separately —
    // otherwise dropping it just silently emits the unwrapped schema.
    it('renders a nullable property as a union with null rather than unwrapping it', () => {
      const { schema: document, warnings } = bodyDocument(z.object({ a: z.string().nullable() }))

      expect(document?.properties?.a).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] })
      expect(warnings).toEqual([])
    })

    // The type and the presence of a property are read by separate walks over
    // separate wrapper lists, so a wrapper added to one and not the other
    // quietly makes an optional property required.
    it('looks through the same wrappers when deciding presence as when reading the type', () => {
      for (const schema of [
        z.object({ a: z.string().optional().readonly() }),
        z.object({ a: z.string().optional().nullable() }),
        z.object({ a: z.string().optional().brand<'Tagged'>() }),
        z.object({ a: z.string().optional().catch('x') }),
      ]) {
        const { schema: document, warnings } = bodyDocument(schema)

        expect(document?.properties?.a).toBeDefined()
        expect(document?.required).toBeUndefined()
        expect(warnings).toEqual([])
      }
    })

    // `.catch()` substitutes its fallback for any failure, a missing value
    // included, so an empty payload parses and the caller owes nothing.
    it('never requires a caught field of a request', () => {
      const schema = () => z.object({ mode: z.string().catch('safe') })

      expect(schema().safeParse({}).success).toBe(true)
      expect(bodyDocument(schema()).schema?.required).toBeUndefined()
      expect(responseDocument(schema()).schema?.required).toEqual(['mode'])
    })

    // A pipeline runs both stages, so reading only the side being rendered
    // documents an omission the other stage rejects.
    it('requires a piped field unless both stages accept a missing value', () => {
      const piped = z.object({ a: z.string().optional().pipe(z.string()) })
      expect(piped.safeParse({}).success).toBe(false)
      expect(bodyDocument(piped).schema?.required).toEqual(['a'])

      const output = z.object({ a: pipeTo(z.string(), z.string().optional()) })
      expect(output.safeParse({}).success).toBe(false)
      expect(responseDocument(output).schema?.required).toEqual(['a'])
    })

    // `z.lazy()` keeps its schema behind a getter this walker does not call.
    // The property is unavoidably absent; what it must not be is silent.
    it('warns rather than quietly dropping a schema it cannot read', () => {
      const { schema: document, warnings } = bodyDocument(z.object({ a: z.lazy(() => z.string()) }))

      expect(document?.properties?.a).toBeUndefined()
      expect(warnings).toEqual(['POST /posts body.a: the contents of a "lazy" schema could not be read, so it is omitted.'])
    })

    // Finding the object behind a parameter schema is a third walk over the
    // same wrappers, and one that reports nothing when it gives up: a wrapper
    // it fails to look through drops every parameter from the document.
    it('expands parameters through a wrapped query schema', () => {
      for (const query of [
        z.object({ page: z.number() }).default({ page: 1 }),
        z.object({ page: z.number() }).optional(),
        z.object({ page: z.number() }).nullable(),
        z.object({ page: z.number() }).readonly(),
      ]) {
        const { parameters, warnings } = queryParameters(query)

        expect(parameters).toEqual([{ name: 'page', in: 'query', required: true, schema: { type: 'number' } }])
        expect(warnings).toEqual([])
      }
    })
  })

  it('writes the generated document to disk', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'guren-openapi-'))
    const definitions: RouteDefinition[] = [{ method: 'GET', path: '/health' }]
    try {
      const result = await writeOpenApiDocument(definitions, {
        title: 'Blog API',
        version: '1.0.0',
        appRoot,
        outputFile: '.guren/openapi.test.json',
        force: true,
      })

      expect(result.outputPath.endsWith('.guren/openapi.test.json')).toBe(true)
    } finally {
      await rm(appRoot, { recursive: true, force: true })
    }
  })
})
